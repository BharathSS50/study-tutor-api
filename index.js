// Force IPv4 preference (safe even if host already IPv4)
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import express from "express";
import cors from "cors";
import { Pool } from "pg";

const app = express();
app.use(express.json());

// ===== CORS (allow same-origin/no-origin & whitelisted origins) =====
const allowed = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowed.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked for origin: " + origin));
    },
  })
);

// ===== Postgres Pool =====
// IMPORTANT: Use an IPv4-capable DATABASE_URL (e.g., Supabase *pooler* host)
// Example: postgres://USER:PASS@aws-0-xxx.pooler.supabase.com:6543/postgres?sslmode=require
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // needed for most managed PG (Supabase/Neon/etc.)
});

// ===== Health =====
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ===================================================================
//                              TUTORS
// ===================================================================
// GET /api/tutors?subject=Math&minRating=4.5
app.get("/api/tutors", async (req, res, next) => {
  try {
    const { subject, minRating } = req.query;
    const params = [];
    const where = [];

    if (subject) {
      params.push(subject);
      where.push(`$${params.length} = ANY (t.subjects)`);
    }
    if (minRating) {
      params.push(Number(minRating));
      where.push(`t.rating >= $${params.length}`);
    }

    const sql = `
      select t.id, t.name, t.subjects, t.hourly_rate, t.rating, t.bio,
             coalesce(
               json_agg(
                 json_build_object('id', s.id, 'start', s.start_time, 'end', s.end_time)
                 order by s.start_time
               ) filter (where s.id is not null),
               '[]'
             ) as slots
      from tutors t
      left join slots s on s.tutor_id = t.id
      ${where.length ? "where " + where.join(" and ") : ""}
      group by t.id
      order by t.name asc
    `;
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// ===================================================================
//                             BOOKINGS
// ===================================================================
// POST /api/bookings  { id, studentId, tutorId, slotId }
app.post("/api/bookings", async (req, res, next) => {
  try {
    const { id, studentId, tutorId, slotId } = req.body || {};
    if (!id || !studentId || !tutorId || !slotId) {
      return res.status(400).json({ error: "missing fields" });
    }
    await pool.query(
      `insert into bookings (id, student_id, tutor_id, slot_id, status)
       values ($1,$2,$3,$4,'booked')`,
      [id, studentId, tutorId, slotId]
    );
    res.status(201).json({ ok: true, id });
  } catch (err) { next(err); }
});

// DELETE /api/bookings/:id  → soft-cancel
app.delete("/api/bookings/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    await pool.query(`update bookings set status='canceled' where id=$1`, [id]);
    res.json({ ok: true, id });
  } catch (err) { next(err); }
});

// ===================================================================
//                               TASKS
// ===================================================================
// GET /api/tasks?userId=u1
app.get("/api/tasks", async (req, res, next) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: "missing userId" });
    const { rows } = await pool.query(
      `select id, user_id as "userId", title, due_date as "dueDate", est_mins as "estMins", status, tags
       from tasks
       where user_id=$1
       order by due_date asc nulls last, id asc`,
      [userId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/tasks   { id, userId, title, dueDate?, estMins?, status?, tags? }
app.post("/api/tasks", async (req, res, next) => {
  try {
    const { id, userId, title, dueDate, estMins = 30, status = "todo", tags = [] } = req.body || {};
    if (!id || !userId || !title) return res.status(400).json({ error: "missing fields" });
    await pool.query(
      `insert into tasks (id, user_id, title, due_date, est_mins, status, tags)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [id, userId, title, dueDate ?? null, estMins, status, tags]
    );
    res.status(201).json({ ok: true, id });
  } catch (err) { next(err); }
});

// PATCH /api/tasks/:id  (any subset of fields)
app.patch("/api/tasks/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, dueDate, estMins, status, tags } = req.body || {};
    const fields = []; const params = [];
    if (title !== undefined)   { params.push(title);   fields.push(`title=$${params.length}`); }
    if (dueDate !== undefined) { params.push(dueDate); fields.push(`due_date=$${params.length}`); }
    if (estMins !== undefined) { params.push(estMins); fields.push(`est_mins=$${params.length}`); }
    if (status !== undefined)  { params.push(status);  fields.push(`status=$${params.length}`); }
    if (tags !== undefined)    { params.push(tags);    fields.push(`tags=$${params.length}`); }
    if (!fields.length) return res.status(400).json({ error: "no fields to update" });
    params.push(id);
    await pool.query(`update tasks set ${fields.join(", ")} where id=$${params.length}`, params);
    res.json({ ok: true, id });
  } catch (err) { next(err); }
});

// ===================================================================
//                              PROGRESS
// ===================================================================
// GET /api/progress?userId=u1&from=2025-08-01&to=2025-08-31
app.get("/api/progress", async (req, res, next) => {
  try {
    const { userId, from, to } = req.query;
    if (!userId) return res.status(400).json({ error: "missing userId" });

    const params = [userId];
    let where = `user_id=$1`;
    if (from) { params.push(from); where += ` and (due_date is null or due_date >= $${params.length})`; }
    if (to)   { params.push(to);   where += ` and (due_date is null or due_date <= $${params.length})`; }

    const { rows } = await pool.query(
      `select
         count(*) filter (where status in ('todo','done'))::int as total,
         count(*) filter (where status='done')::int as done
       from tasks
       where ${where}`, params
    );
    const { total = 0, done = 0 } = rows[0] || {};
    const percent = total ? Math.round((done / total) * 100) : 0;
    res.json({ total, done, percent });
  } catch (err) { next(err); }
});

// ===================================================================
//                                AI
// ===================================================================
// POST /api/ai/study-plan  { goal?, examDate, hoursPerWeek?, subjects?[] }
app.post("/api/ai/study-plan", async (req, res, next) => {
  try {
    const { goal = "Exam prep", examDate, hoursPerWeek = 4, subjects = ["General"] } = req.body || {};
    if (!examDate) return res.status(400).json({ error: "missing examDate" });

    const start = new Date();
    const end = new Date(examDate);
    const days = Math.max(1, Math.ceil((end - start) / (1000 * 60 * 60 * 24)));
    const totalMins = Math.max(60, Number(hoursPerWeek) * 60);
    const perDay = Math.max(20, Math.round(totalMins / 5)); // 5 study days/week

    const tasks = [];
    let day = 0, i = 1;
    while (day < days) {
      const dt = new Date(start.getTime() + day * 24 * 60 * 60 * 1000);
      if (dt.getDay() !== 6) { // skip Saturdays
        const subject = subjects[(i - 1) % subjects.length];
        tasks.push({
          title: `${subject}: ${goal} session ${i}`,
          dueDate: dt.toISOString().slice(0, 10),
          estMins: perDay,
          status: "todo",
          tags: [subject.toLowerCase(), "plan"],
        });
        i++;
      }
      day++;
    }
    res.json({ tasks });
  } catch (err) { next(err); }
});

// ===== Error handler (always JSON) =====
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "server_error" });
});

// ===== Start =====
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API listening on :${port}`));

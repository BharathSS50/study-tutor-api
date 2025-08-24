const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const allowed = (process.env.CORS_ORIGIN || "").split(",");
app.use(cors({ origin: (o, cb) => cb(null, !o || allowed.includes(o)) }));

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/tutors", async (_req, res) => {
  const { rows } = await pool.query(`
    select t.id, t.name, t.subjects, t.hourly_rate, t.rating, t.bio,
           coalesce(json_agg(json_build_object('id', s.id, 'start', s.start_time, 'end', s.end_time)
                    order by s.start_time) filter (where s.id is not null), '[]') as slots
    from tutors t
    left join slots s on s.tutor_id = t.id
    group by t.id
    order by t.name asc
  `);
  res.json(rows);
});

app.post("/api/bookings", async (req, res) => {
  const { id, studentId, tutorId, slotId } = req.body;
  if (!id || !studentId || !tutorId || !slotId) return res.status(400).json({ error: "missing fields" });
  await pool.query(
    `insert into bookings (id, student_id, tutor_id, slot_id, status) values ($1,$2,$3,$4,'booked')`,
    [id, studentId, tutorId, slotId]
  );
  res.status(201).json({ ok: true, id });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API listening on :${port}`));

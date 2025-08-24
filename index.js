// Force IPv4 preference (harmless even if host already IPv4)
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import express from "express";
import cors from "cors";
import { Pool } from "pg";

const app = express();
app.use(express.json());

// Allow no-origin (curl/health) and specific origins from CORS_ORIGIN
const allowed = (process.env.CORS_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowed.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked for origin: " + origin));
    },
  })
);

// ---- Postgres Pool ----
// IMPORTANT: Use an IPv4-capable DATABASE_URL (e.g., Supabase pooler host)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // needed for most managed PG (Supabase/Neon/etc.)
});

// Health check
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Tutors + slots
app.get("/api/tutors", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`
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
      group by t.id
      order by t.name asc
    `);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Create booking
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
  } catch (err) {
    next(err);
  }
});

// Basic error handler (keeps responses JSON)
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "server_error" });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API listening on :${port}`));

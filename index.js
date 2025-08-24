import dns from "node:dns/promises";
import { URL } from "node:url";
import { Pool } from "pg";

// Prefer IPv4 globally (harmless even with step 1)
import dnsCtl from "node:dns";
dnsCtl.setDefaultResultOrder("ipv4first");

// Parse DATABASE_URL and pin host to IPv4
const dbUrl = new URL(process.env.DATABASE_URL);
const [ipv4] = await dns.resolve4(dbUrl.hostname); // get A record

const pool = new Pool({
  host: ipv4, // <- IPv4 only
  port: Number(dbUrl.port || 5432),
  user: decodeURIComponent(dbUrl.username),
  password: decodeURIComponent(dbUrl.password),
  database: dbUrl.pathname.replace(/^\//, ""),
  ssl: { rejectUnauthorized: false }, // keep for Supabase/Neon
});


const app = express();
app.use(json());

const allowed = (process.env.CORS_ORIGIN || "").split(",");
app.use(cors({ origin: (o, cb) => cb(null, !o || allowed.includes(o)) }));

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

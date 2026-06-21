import Database from "better-sqlite3";

const db = new Database("app.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    phone TEXT,
    lat REAL,
    lng REAL,
    household_size INTEGER,
    has_car INTEGER,
    mobility_needs TEXT,
    pets INTEGER,
    language TEXT
  );
`);

export function seedProfiles() {
  const count = db.prepare("SELECT COUNT(*) AS n FROM profiles").get() as { n: number };
  if (count.n > 0) return;
  const insert = db.prepare(`INSERT INTO profiles
    (name, phone, lat, lng, household_size, has_car, mobility_needs, pets, language)
    VALUES (@name,@phone,@lat,@lng,@household_size,@has_car,@mobility_needs,@pets,@language)`);
  insert.run({ name: "Family of five", phone: process.env.TEST_TO_NUMBER || "",
    lat: 20.875, lng: -156.675, household_size: 5, has_car: 1, mobility_needs: "none", pets: 1, language: "en" });
  insert.run({ name: "Solo, no car", phone: process.env.TEST_TO_NUMBER || "",
    lat: 20.876, lng: -156.672, household_size: 1, has_car: 0, mobility_needs: "limited", pets: 0, language: "en" });
}

export function getProfile(id: number) {
  return db.prepare("SELECT * FROM profiles WHERE id = ?").get(id);
}

export function allProfiles() {
  return db.prepare("SELECT * FROM profiles").all();
}

export default db;

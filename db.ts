import Database from 'better-sqlite3';
import { Firestore } from '@google-cloud/firestore';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Configuration ---
const USE_FIRESTORE = process.env.USE_FIRESTORE === 'true';

// --- SQLite Setup ---
let sqlite: any = null;
function getSqlite() {
  if (!sqlite) {
    const dbPath = path.resolve(__dirname, 'database.sqlite');
    sqlite = new Database(dbPath);
  }
  return sqlite;
}

// --- Firestore Setup ---
let firestore: Firestore | null = null;
if (USE_FIRESTORE) {
  firestore = new Firestore();
}

// --- Database Interface ---
export const db = {
  async getProducts(query?: string) {
    if (USE_FIRESTORE && firestore) {
      let q: any = firestore.collection('products');
      if (query) {
        // Simple search simulation in Firestore
        const snapshot = await q.where('name', '>=', query).where('name', '<=', query + '\uf8ff').get();
        return snapshot.docs.map((doc: any) => ({ id: doc.id, ...doc.data() }));
      }
      const snapshot = await q.get();
      return snapshot.docs.map((doc: any) => ({ id: doc.id, ...doc.data() }));
    } else {
      const db = getSqlite();
      if (query) {
        const stmt = db.prepare('SELECT * FROM products WHERE name LIKE ? OR description LIKE ? OR category LIKE ?');
        const searchStr = `%${query}%`;
        return stmt.all(searchStr, searchStr, searchStr);
      }
      return db.prepare('SELECT * FROM products').all();
    }
  },

  async addProduct(product: { name: string; description: string; price: number; category: string }) {
    if (USE_FIRESTORE && firestore) {
      const docRef = await firestore.collection('products').add(product);
      return { id: docRef.id, ...product };
    } else {
      const db = getSqlite();
      const stmt = db.prepare('INSERT INTO products (name, description, price, category) VALUES (?, ?, ?, ?)');
      const info = stmt.run(product.name, product.description, product.price, product.category);
      return { id: info.lastInsertRowid, ...product };
    }
  },

  async getFollowUps() {
    if (USE_FIRESTORE && firestore) {
      const snapshot = await firestore.collection('follow_ups').orderBy('created_at', 'desc').get();
      return snapshot.docs.map((doc: any) => ({ id: doc.id, ...doc.data() }));
    } else {
      const db = getSqlite();
      return db.prepare('SELECT * FROM follow_ups ORDER BY created_at DESC').all();
    }
  },

  async addFollowUp(followUp: { contactType: string; contactAddress: string; message: string }) {
    const data = {
      ...followUp,
      status: 'sent',
      created_at: new Date().toISOString()
    };

    if (USE_FIRESTORE && firestore) {
      const docRef = await firestore.collection('follow_ups').add(data);
      return { id: docRef.id, ...data };
    } else {
      const db = getSqlite();
      const stmt = db.prepare('INSERT INTO follow_ups (contact_type, contact_address, message, status, created_at) VALUES (?, ?, ?, ?, ?)');
      const info = stmt.run(data.contactType, data.contactAddress, data.message, data.status, data.created_at);
      return { id: info.lastInsertRowid, ...data };
    }
  },

  // Initialize tables/collections
  init() {
    if (!USE_FIRESTORE) {
      const db = getSqlite();
      db.exec(`
        CREATE TABLE IF NOT EXISTS products (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT,
          price REAL,
          category TEXT
        );

        CREATE TABLE IF NOT EXISTS follow_ups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contact_type TEXT NOT NULL,
          contact_address TEXT NOT NULL,
          message TEXT NOT NULL,
          status TEXT DEFAULT 'pending',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Seed if empty
      const count = (db.prepare('SELECT COUNT(*) as count FROM products').get() as any).count;
      if (count === 0) {
        const insert = db.prepare('INSERT INTO products (name, description, price, category) VALUES (?, ?, ?, ?)');
        insert.run('Solar Inverter 5KVA', 'High efficiency pure sine wave solar inverter suitable for home and office use.', 500000, 'Energy');
        insert.run('Generator 10KVA', 'Heavy duty diesel generator with low noise and high fuel efficiency.', 1200000, 'Energy');
        insert.run('CCTV Camera System', '4-channel 1080p HD security camera system with night vision and mobile app access.', 150000, 'Security');
        insert.run('Smart Home Hub', 'Centralized control for all your smart home devices. Voice control compatible.', 85000, 'Smart Home');
        insert.run('Water Purifier', 'Reverse osmosis water purification system for clean drinking water.', 120000, 'Home Appliances');
      }
    }
  }
};

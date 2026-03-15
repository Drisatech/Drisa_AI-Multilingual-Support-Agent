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
async function getSqlite() {
  if (!sqlite) {
    try {
      const { default: Database } = await import('better-sqlite3');
      // On Cloud Run (production), the root filesystem is read-only.
      // We use /tmp for the SQLite database if not using Firestore.
      const dbPath = process.env.NODE_ENV === 'production' 
        ? '/tmp/database.sqlite' 
        : path.resolve(__dirname, 'database.sqlite');
      console.log(`[Database] Opening SQLite at ${dbPath}`);
      sqlite = new Database(dbPath);
    } catch (err) {
      console.error('[Database] Failed to initialize SQLite:', err);
      throw err;
    }
  }
  return sqlite;
}

// --- Firestore Setup ---
let firestore: Firestore | null = null;
function getFirestore() {
  if (USE_FIRESTORE && !firestore) {
    try {
      firestore = new Firestore();
    } catch (err) {
      console.error('[Database] Failed to initialize Firestore:', err);
    }
  }
  return firestore;
}

// --- Database Interface ---
export const db = {
  async getProducts(query?: string) {
    const firestore = getFirestore();
    if (USE_FIRESTORE && firestore) {
      let q: any = firestore.collection('products');
      if (query) {
        // Simple search simulation in Firestore
        const snapshot = await q.where('name', '>=', query).where('name', '<=', query + '\uf8ff').get();
        return snapshot.docs.map((doc: any) => ({ id: doc.id, ...doc.data() }));
      }
      const snapshot = await q.orderBy('updatedAt', 'desc').get();
      return snapshot.docs.map((doc: any) => ({ id: doc.id, ...doc.data() }));
    } else {
      const db = await getSqlite();
      if (query) {
        const stmt = db.prepare('SELECT * FROM products WHERE name LIKE ? OR description LIKE ? OR category LIKE ?');
        const searchStr = `%${query}%`;
        return stmt.all(searchStr, searchStr, searchStr);
      }
      return db.prepare('SELECT * FROM products ORDER BY id DESC').all();
    }
  },

  async addProduct(product: { name: string; description: string; price: number; category: string }) {
    const data = {
      ...product,
      updatedAt: new Date().toISOString()
    };
    const firestore = getFirestore();
    if (USE_FIRESTORE && firestore) {
      const docRef = await firestore.collection('products').add(data);
      return { id: docRef.id, ...data };
    } else {
      const db = await getSqlite();
      const stmt = db.prepare('INSERT INTO products (name, description, price, category) VALUES (?, ?, ?, ?)');
      const info = stmt.run(product.name, product.description, product.price, product.category);
      return { id: info.lastInsertRowid, ...data };
    }
  },

  async getFollowUps() {
    const firestore = getFirestore();
    if (USE_FIRESTORE && firestore) {
      const snapshot = await firestore.collection('follow_ups').orderBy('created_at', 'desc').get();
      return snapshot.docs.map((doc: any) => ({ id: doc.id, ...doc.data() }));
    } else {
      const db = await getSqlite();
      return db.prepare('SELECT * FROM follow_ups ORDER BY created_at DESC').all();
    }
  },

  async addFollowUp(followUp: { contactType: string; contactAddress: string; message: string }) {
    const data = {
      contact_type: followUp.contactType,
      contact_address: followUp.contactAddress,
      message: followUp.message,
      status: 'sent',
      created_at: new Date().toISOString()
    };

    const firestore = getFirestore();
    if (USE_FIRESTORE && firestore) {
      const docRef = await firestore.collection('follow_ups').add(data);
      return { id: docRef.id, ...data };
    } else {
      const db = await getSqlite();
      const stmt = db.prepare('INSERT INTO follow_ups (contact_type, contact_address, message, status, created_at) VALUES (?, ?, ?, ?, ?)');
      const info = stmt.run(data.contact_type, data.contact_address, data.message, data.status, data.created_at);
      return { id: info.lastInsertRowid, ...data };
    }
  },

  // Initialize tables/collections
  async init() {
    if (!USE_FIRESTORE) {
      const db = await getSqlite();
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

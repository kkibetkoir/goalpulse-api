const { db, admin, auth  } = require("../config/firebase");
const { Timestamp } = require("firebase-admin/firestore");
const fs = require("fs");

const COLLECTION = "users";

/**
 * Create a customer
 */
async function createCustomer(data) {
  const now = Timestamp.now();
  const docRef = await db.collection(COLLECTION).add({
    ...data,
    tier: data.tier || "free",
    createdAt: now,
    updatedAt: now,
  });
  const snapshot = await docRef.get();
  return { id: docRef.id, ...snapshot.data() };
}

/**
 * Get a single customer by ID
 */
async function getCustomerById(id) {
  const doc = await db.collection(COLLECTION).doc(id).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

/**
 * List customers (with optional filters)
 */
async function listCustomers({ tier, limit = 50 } = {}) {
  let query = db.collection(COLLECTION).limit(Number(limit));
  if (tier) query = query.where("tier", "==", tier);

  const snapshot = await query.get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function appendNewEmailsToCsv() {
  const filePath = "user-emails.csv";

  try {
    // 1. Load existing emails into a Set for fast lookup
    const existingEmails = new Set();

    if (fs.existsSync(filePath)) {
      const fileContent = fs.readFileSync(filePath, "utf8");
      fileContent
        .split(/\r?\n/) // Split by newline (handles Windows & Mac/Linux)
        .map((line) => line.trim())
        .filter((line) => line && line !== "email") // Skip empty lines and header
        .forEach((email) => existingEmails.add(email));
    } else {
      // Create the file with the header if it doesn't exist yet
      fs.writeFileSync(filePath, "email\n", "utf8");
    }

    // 2. Fetch all document IDs from Firestore
    //const docRefs = await db.collection(COLLECTION).listDocuments();
    //const fetchedEmails = docRefs.map((doc) => doc.id);
    
    // 2. Fetch all documents from Firestore
    const snapshot = await db.collection("contacts").get();
    const fetchedEmails = snapshot.docs
      .map((doc) => doc.data().email)
      .filter(Boolean);

    // 3. Filter out any emails that already exist in the CSV
    const newEmails = fetchedEmails.filter(
      (email) => !existingEmails.has(email),
    );

    if (newEmails.length === 0) {
      console.log("No new emails to add.");
      return;
    }

    // 4. Append only the new emails to the bottom of the CSV
    const rowsToAppend = newEmails.join("\n") + "\n";
    fs.appendFileSync(filePath, rowsToAppend, "utf8");

    console.log(`Added ${newEmails.length} new emails to ${filePath}.`);
  } catch (error) {
    console.error("Error updating CSV:", error);
  }
}

async function deleteAllUsers(nextPageToken) {
  try {
    // Fetch up to 1,000 users at a time
    const listUsersResult = await auth.listUsers(1000, nextPageToken); //await admin.auth().listUsers(1000, nextPageToken);
    const uids = listUsersResult.users.map((userRecord) => userRecord.uid);

    if (uids.length > 0) {
      const deleteResult = await auth.deleteUsers(uids); //await admin.auth().deleteUsers(uids);
      console.log(`Successfully deleted ${deleteResult.successCount} users.`);
      if (deleteResult.failureCount > 0) {
        console.error(
          `Failed to delete ${deleteResult.failureCount} users:`,
          deleteResult.errors,
        );
      }
    } else {
      console.log("No users found to delete.");
    }

    // Recursively delete the next batch if more users exist
    if (listUsersResult.pageToken) {
      await deleteAllUsers(listUsersResult.pageToken);
    } else {
      console.log("Finished deleting all users.");
    }
  } catch (error) {
    console.error("Error deleting users:", error);
  }
}

/**
 * Delete ALL documents in the users Firestore collection (batched).
 * Returns count of deleted documents.
 *
 * Note: This deletes Firestore docs only — it does NOT delete
 * Firebase Auth users. Use deleteAllUsers() for that.
 */
async function deleteAllCustomers() {
  const BATCH_SIZE = 500;
  let totalDeleted = 0;

  while (true) {
    // Fetch a page of documents (only refs needed — no data read cost)
    const snapshot = await db.collection(COLLECTION).limit(BATCH_SIZE).get();

    if (snapshot.empty) break;

    const batch = db.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    totalDeleted += snapshot.size;
    console.log(`Deleted ${totalDeleted} customers so far...`);

    // If we got fewer than BATCH_SIZE, we've reached the end
    if (snapshot.size < BATCH_SIZE) break;
  }

  console.log(`Finished. Deleted ${totalDeleted} customers total.`);
  return { deleted: totalDeleted };
}

/**
 * Update a customer
 */
async function updateCustomer(id, updates) {
  const docRef = db.collection(COLLECTION).doc(id);
  const doc = await docRef.get();
  if (!doc.exists) return null;

  await docRef.update({
    ...updates,
    updatedAt: Timestamp.now(),
  });

  const updated = await docRef.get();
  return { id: updated.id, ...updated.data() };
}

/**
 * Delete a customer
 */
async function deleteCustomer(id) {
  const docRef = db.collection(COLLECTION).doc(id);
  const doc = await docRef.get();
  if (!doc.exists) return false;

  await docRef.delete();
  return true;
}

/**
 * Downgrade all premium customers to free tier (batched)
 * Returns count of customers downgraded
 */
/*async function downgradeAllPremiumCustomers() {
  const snapshot = await db
    .collection(COLLECTION)
    .where('tier', '==', 'premium')
    .get();

  if (snapshot.empty) return { downgraded: 0 };

  // Firestore batch limit is 500 writes
  const BATCH_SIZE = 500;
  let batch = db.batch();
  let count = 0;
  let total = 0;
  const now = Timestamp.now();

  for (const doc of snapshot.docs) {
    batch.update(doc.ref, {
      tier: 'free',
      downgradedAt: now,
      updatedAt: now,
    });
    count++;
    total++;

    if (count === BATCH_SIZE) {
      await batch.commit();
      batch = db.batch();
      count = 0;
    }
  }

  if (count > 0) await batch.commit();

  return { downgraded: total };
}*/

const TIME_LIMITS = {
  Daily: 1 * 24 * 60 * 60 * 1000,
  Weekly: 7 * 24 * 60 * 60 * 1000,
  Monthly: 30 * 24 * 60 * 60 * 1000,
  Yearly: 365 * 24 * 60 * 60 * 1000,
};

/**
 * Parse a subDate string like "2024-05-01" or "2024-05-01T14:30"
 * into a JS Date (local time — matches the frontend behavior).
 */
function parseSubDate(str) {
  const [datePart, timePart = "00:00"] = str.split("T");
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm] = timePart.split(":").map(Number);
  return new Date(y, m - 1, d, hh || 0, mm || 0, 0);
}

/**
 * Returns true if the customer's subscription has expired
 * based on subDate + plan, using the same rules as the frontend.
 */
function isSubscriptionExpired(customer, now = Date.now()) {
  const sub = customer.subscription;
  if (!sub || !sub.subDate) return true; // no sub data → treat as expired

  const plan = sub.plan || sub.billing;
  const limit = TIME_LIMITS[plan];
  if (limit === undefined) {
    console.warn(`[CRON] Unknown plan "${plan}" for customer ${customer.id}`);
    return false; // don't downgrade on unknown plan — safer
  }

  const startTime = parseSubDate(sub.subDate).getTime();
  return now - startTime >= limit;
}

/**
 * Downgrade only customers whose subscription has actually expired.
 */
async function downgradeAllPremiumCustomers() {
  const snapshot = await db
    .collection(COLLECTION)
    .where("isPremium", "==", true)
    .get();

  if (snapshot.empty) return { downgraded: 0, scanned: 0 };

  const now = Date.now();
  const nowTs = Timestamp.now();
  const BATCH_SIZE = 500;
  let batch = db.batch();
  let pending = 0;
  let downgraded = 0;

  for (const doc of snapshot.docs) {
    const customer = { id: doc.id, ...doc.data() };

    if (!isSubscriptionExpired(customer, now)) continue;

    batch.update(doc.ref, {
      isPremium: false,
      subscription: null,
      downgradedAt: nowTs,
      updatedAt: nowTs,
    });

    pending++;
    downgraded++;

    if (pending === BATCH_SIZE) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
    }
  }

  if (pending > 0) await batch.commit();

  return { downgraded, scanned: snapshot.size };
}

module.exports = {
  createCustomer,
  getCustomerById,
  listCustomers,
  updateCustomer,
  deleteCustomer,
  downgradeAllPremiumCustomers,
  isSubscriptionExpired, // export in case you want to use it elsewhere
  appendNewEmailsToCsv,
  deleteAllUsers,
  deleteAllCustomers,
};

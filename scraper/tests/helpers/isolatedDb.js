// =============================================================================
// scraper/tests/helpers/isolatedDb.js
// =============================================================================
// WHAT: Isolated in-memory MongoDB for Phase 4 tests. Never touches MONGO_URI.
// WHY: Phase 4 staging tests must not read or write production/demo data.
//   Every test file gets its own database name on an ephemeral in-memory server.
// =============================================================================

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { getRawDocumentModel } = require("../../models/rawDocument");

async function startIsolatedDb(dbName) {
  const mongod = await MongoMemoryServer.create();
  const mongoUri = mongod.getUri(dbName || "phase4_test");
  if (
    process.env.MONGO_URI &&
    mongoUri === process.env.MONGO_URI
  ) {
    throw new Error("isolatedDb: test URI collides with production MONGO_URI");
  }
  return { mongod, mongoUri };
}

async function connectRawDocuments(mongoUri) {
  const connection = await mongoose.createConnection(mongoUri).asPromise();
  const RawDocument = getRawDocumentModel(connection);
  return { connection, RawDocument };
}

async function closeIsolatedDb({ mongod, connection }) {
  if (connection) await connection.close();
  if (mongod) await mongod.stop();
}

module.exports = {
  startIsolatedDb,
  connectRawDocuments,
  closeIsolatedDb,
};

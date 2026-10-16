import assert from "node:assert/strict";

function matches(row, where = {}) {
  if (!row) return false;
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") return value.some((part) => matches(row, part));
    const actual = row[key];
    if (value && typeof value === "object" && !(value instanceof Date)) {
      return Object.entries(value).every(([op, expected]) => {
        if (op === "in") return expected.includes(actual);
        if (op === "notIn") return !expected.includes(actual);
        if (op === "lte") return actual !== null && actual <= expected;
        if (op === "lt") return actual !== null && actual < expected;
        if (op === "gt") return actual !== null && actual > expected;
        return matches(actual, { [op]: expected });
      });
    }
    return actual instanceof Date && value instanceof Date
      ? +actual === +value
      : actual === value;
  });
}
function assign(row, data) {
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined)
      row[key] = value?.increment ? row[key] + value.increment : value;
  }
}

export function webhookFixture() {
  let state = {
    shops: [],
    receipts: [],
    leases: [],
    products: [],
    events: [],
    queues: [],
  };
  let serial = Promise.resolve();
  const fixture = {
    get state() {
      return state;
    },
    failCommit: false,
    commitGate: null,
    eventFailure: false,
  };
  function model(table) {
    return {
      async upsert({ where, create, update }) {
        let row = state[table].find((row) =>
          matches(row, where.shopId_shopifyProductGid ?? where),
        );
        if (row) assign(row, update);
        else {
          row = { id: `${table}-${state[table].length + 1}`, ...create };
          if (table === "shops")
            Object.assign(row, {
              primaryDomain: "store.example",
              productWebhookNextAttemptAt: new Date(0),
            });
          if (table === "leases")
            Object.assign(row, { ownerToken: null, leaseUntil: null });
          state[table].push(row);
        }
        if (["products", "queues"].includes(table)) row.updatedAt = new Date();
        return structuredClone(row);
      },
      async findUnique({ where, select }) {
        const effective = where.shopId_shopifyProductGid ?? where;
        const row = state[table].find((row) => matches(row, effective)) ?? null;
        return structuredClone(row && select ? Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, row[k]])) : row);
      },
      async findMany({ where = {}, take, include } = {}) {
        const rows = state[table].map(row => include?.shop ? { ...row, shop: state.shops.find(s => s.id === row.shopId) } : row).filter(row => matches(row, where));
        return structuredClone(take === undefined ? rows : rows.slice(0, take));
      },
      async findUniqueOrThrow(args) {
        const row = await this.findUnique(args);
        assert.ok(row);
        return row;
      },
      async findFirst({ where }) {
        return structuredClone(
          state[table].find((row) => matches(row, where)) ?? null,
        );
      },
      async createMany({ data, skipDuplicates }) {
        assert.equal(skipDuplicates, true);
        let count = 0;
        for (const input of data) {
          if (state[table].some((row) => row.dedupeKey === input.dedupeKey))
            continue;
          state[table].push({
            id: `${table}-${state[table].length + 1}`,
            status: "PENDING",
            updatedAt: new Date(),
            createdAt: new Date(),
            claimedAt: null,
            ...input,
          });
          count++;
        }
        return { count };
      },
      async update({ where, data }) {
        const row = state[table].find((row) => matches(row, where));
        assert.ok(row);
        assign(row, data);
        if (["products", "queues"].includes(table)) row.updatedAt = new Date();
        return structuredClone(row);
      },
      async updateMany({ where, data }) {
        const rows = state[table].filter((row) => matches(table === "receipts" ? { ...row, shop: state.shops.find(s => s.id === row.shopId) } : row, where));
        rows.forEach((row) => assign(row, data));
        if (["products", "queues"].includes(table)) rows.forEach(row => { row.updatedAt = new Date(); });
        return { count: rows.length };
      },
      async create({ data }) {
        if (table === "events" && fixture.eventFailure)
          throw new Error("synthetic downstream failure");
        const row = { id: `${table}-${state[table].length + 1}`, ...data };
        state[table].push(row);
        return structuredClone(row);
      },
    };
  }
  const client = {
    shop: model("shops"),
    providerAutomationLease: model("leases"),
    productIndexState: model("products"),
    indexEvent: model("events"),
    indexQueueItem: model("queues"),
    webhookReceipt: {
      ...model("receipts"),
      async findUnique({ where, include }) {
        const row = state.receipts.find(row => matches(row, where));
        return row ? structuredClone(include?.shop ? { ...row, shop: state.shops.find(s => s.id === row.shopId) } : row) : null;
      },
      async createMany({ data, skipDuplicates }) {
        assert.equal(skipDuplicates, true);
        if (
          state.receipts.some(
            (row) =>
              row.shopId === data.shopId && row.webhookId === data.webhookId,
          )
        )
          return { count: 0 };
        state.receipts.push({
          id: `receipt-${state.receipts.length + 1}`,
          attemptCount: 0,
          claimToken: null,
          claimedAt: null,
          completedAt: null,
          lastErrorClass: null,
          ...data,
        });
        return { count: 1 };
      },
      async findFirst({ where, orderBy }) {
        const rows = state.receipts
          .map((row) => ({
            ...row,
            shop: state.shops.find((shop) => shop.id === row.shopId),
          }))
          .filter((row) => matches(row, where));
        rows.sort((a, b) => {
          for (const spec of orderBy) {
            const key = Object.keys(spec)[0];
            if (a[key] < b[key]) return -1;
            if (a[key] > b[key]) return 1;
          }
          return 0;
        });
        return structuredClone(rows[0] ?? null);
      },
    },
    async $transaction(callback, options) {
      assert.equal(options.isolationLevel, "Serializable");
      const previous = serial;
      let unlock;
      serial = new Promise((resolve) => {
        unlock = resolve;
      });
      await previous;
      const before = structuredClone(state);
      try {
        const result = await callback(client);
        if (fixture.commitGate) await fixture.commitGate;
        if (fixture.failCommit) throw new Error("synthetic commit failure");
        return result;
      } catch (error) {
        state = before;
        throw error;
      } finally {
        unlock();
      }
    },
    async $disconnect() {},
  };
  fixture.client = client;
  fixture.tx = (callback) =>
    client.$transaction(callback, { isolationLevel: "Serializable" });
  return fixture;
}

// Synthetic identities only; 20 distinct deliveries deliberately cover 17 products.
export function manifestDrainFixture(at = new Date("2026-01-01T00:00:00.000Z")) {
  const f = webhookFixture();
  f.state.shops.push({ id: "drain-shop", domain: "drain-test.myshopify.com", primaryDomain: "store.example", productWebhookNextAttemptAt: new Date(0), updatedAt: at });
  for (let i = 0; i < 20; i++) f.state.receipts.push({ id: `drain-${String(i).padStart(2, "0")}`, shopId: "drain-shop", webhookId: `delivery-${i}`, shopifyProductGid: `gid://shopify/Product/${i % 17 + 1}`, topic: "products/update", status: "PENDING", attemptCount: 0, claimToken: null, claimedAt: null, nextAttemptAt: new Date(0), receivedAt: new Date(+at + i), completedAt: null, processedAt: null, lastErrorClass: null });
  for (let i = 0; i < 17; i++) f.state.products.push({ id: `product-${i}`, shopId: "drain-shop", shopifyProductGid: `gid://shopify/Product/${i + 1}`, contentHash: "a".repeat(64), previousContentHash: null, deletedAt: null, shopifyUpdatedAt: new Date(0), lastDetectedAt: at, updatedAt: at, indexabilityState: "INDEXABLE", canonicalUrl: "https://store.example/products/sample" });
  return f;
}

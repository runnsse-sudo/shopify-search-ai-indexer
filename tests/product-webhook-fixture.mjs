import assert from "node:assert/strict";

function matches(row, where = {}) {
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
        return structuredClone(row);
      },
      async findUnique({ where }) {
        const effective = where.shopId_shopifyProductGid ?? where;
        return structuredClone(
          state[table].find((row) => matches(row, effective)) ?? null,
        );
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
        return structuredClone(row);
      },
      async updateMany({ where, data }) {
        const rows = state[table].filter((row) => matches(row, where));
        rows.forEach((row) => assign(row, data));
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

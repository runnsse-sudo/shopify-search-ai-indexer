import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectCatalogSetup, setupIdentityQuery, setupFilesQuery } from '../app/services/llm-visibility/catalog-setup.server.ts';
import { CATALOG_SHOPS } from '../app/services/llm-visibility/multishop-catalog-targets.ts';
import { validateLlmAuditRequest } from '../app/services/llm-visibility/llm-delivery.ts';

function fixture(shop = CATALOG_SHOPS[0], options = {}) {
  const calls = [];
  const file = shop === 'robotto-7143.myshopify.com'
    ? { id: 'gid://shopify/GenericFile/62861370655066', fileStatus: 'READY', url: 'https://cdn.shopify.com/s/files/1/0766/2777/1738/files/llms-full.txt?v=123' }
    : { id: 'gid://shopify/GenericFile/100', fileStatus: 'READY', url: 'https://cdn.shopify.com/s/files/1/1111/2222/files/llms-full.txt?v=123' };
  const admin = {
    async graphql(query) {
      calls.push(query);
      assert.ok(query === setupIdentityQuery || query === setupFilesQuery, 'unexpected query/mutation');
      assert.doesNotMatch(query, /mutation|stagedUploads|fileUpdate|fileCreate/);
      if (options.httpError) return new Response('', { status: 403 });
      if (options.graphqlError) return Response.json({ errors: [{ message: 'PRIVATE_PROVIDER_DETAIL' }], data: null });
      if (query === setupIdentityQuery) return Response.json({ data: {
        shop: { myshopifyDomain: options.foreignShop ?? shop, primaryDomain: { host: options.host ?? (shop === 'robotto-7143.myshopify.com' ? 'www.robotto.se' : 'store.example') } },
        currentAppInstallation: { accessScopes: options.scopes ?? [{ handle: 'write_files' }] },
        secret: 'DO_NOT_EXPORT',
      }});
      return Response.json({ data: { files: options.files ?? { nodes: [{ ...file, ...options.file }], pageInfo: { hasNextPage: false } } } });
    },
  };
  return { admin, calls };
}

for (const shop of CATALOG_SHOPS) test(`setup binds only its own shop and file: ${shop}`, async () => {
  const { admin, calls } = fixture(shop);
  const result = await inspectCatalogSetup(shop, admin);
  assert.equal(result.shop, shop);
  assert.equal(result.target.shop, shop);
  assert.equal(result.fileStatus, 'EXISTING_FILE_READY');
  assert.equal(result.fileAccess, 'GRANTED');
  assert.equal(result.activation.ready, false);
  assert.equal(result.mode, 'PREPARATION_ONLY');
  assert.equal(result.writesPerformed, 0);
  assert.equal(calls.length, 2);
  assert.equal(result.initialPublication.theme.id, null);
  assert.equal(result.initialPublication.templateOwnership, 'UNKNOWN');
  assert.deepEqual(result.initialPublication.protectedPaths, ['/agents.md', '/llms.txt']);
  assert.equal(result.initialPublication.separateApprovalRequired, true);
  assert.ok(!JSON.stringify(result).includes('DO_NOT_EXPORT'));
});

test('unsupported shops stop before any API access', async () => {
  const f = fixture();
  await assert.rejects(inspectCatalogSetup('other.myshopify.com', f.admin), /CATALOG_SHOP_NOT_ALLOWED/);
  assert.equal(f.calls.length, 0);
});

test('wrong store identity stops before file lookup', async () => {
  const f = fixture(CATALOG_SHOPS[0], { foreignShop: CATALOG_SHOPS[1] });
  await assert.rejects(inspectCatalogSetup(CATALOG_SHOPS[0], f.admin), /SHOP_MISMATCH/);
  assert.equal(f.calls.length, 1);
});

test('missing file access yields an explicit consent blocker without file lookup or scope request', async () => {
  const f = fixture(CATALOG_SHOPS[0], { scopes: [{ handle: 'read_products' }] });
  const r = await inspectCatalogSetup(CATALOG_SHOPS[0], f.admin);
  assert.equal(r.fileStatus, 'FILE_ACCESS_REQUIRED');
  assert.equal(r.fileAccess, 'REQUIRES_MERCHANT_CONSENT');
  assert.equal(r.target, null);
  assert.equal(r.initialPublication.operation, 'NO_AUTOMATIC_OPERATION');
  assert.equal(f.calls.length, 1);
});

test('read_files permits inspection but cannot imply write_files or activation', async () => {
  const f = fixture(CATALOG_SHOPS[0], { scopes: [{ handle: 'read_files' }] });
  const r = await inspectCatalogSetup(CATALOG_SHOPS[0], f.admin);
  assert.equal(r.fileStatus, 'EXISTING_FILE_READY');
  assert.equal(r.fileAccess, 'REQUIRES_MERCHANT_CONSENT');
  assert.ok(r.activation.blockers.includes('WRITE_FILES_CONSENT_REQUIRED'));
});

test('no file produces a shop-bound initial publication draft with no invented ID', async () => {
  for (const shop of CATALOG_SHOPS) {
    const f = fixture(shop, { files: { nodes: [], pageInfo: { hasNextPage: false } } });
    const r = await inspectCatalogSetup(shop, f.admin);
    assert.equal(r.target, null);
    assert.equal(r.initialPublication.operation, 'PROPOSE_INITIAL_FILE');
    assert.equal(r.initialPublication.filename, 'llms-full.txt');
    assert.equal(r.activation.ready, false);
    assert.match(r.initialPublication.backup, /SHA256/);
    assert.match(r.initialPublication.rollback, /ONLY_OWN_NEW_ARTIFACTS/);
  }
});

test('multiple candidates or incomplete pagination never select an arbitrary file', async () => {
  for (const files of [
    { nodes: [{}, {}], pageInfo: { hasNextPage: false } },
    { nodes: [], pageInfo: { hasNextPage: true } },
  ]) {
    const f = fixture(CATALOG_SHOPS[0], { files });
    const r = await inspectCatalogSetup(CATALOG_SHOPS[0], f.admin);
    assert.equal(r.fileStatus, 'AMBIGUOUS_FILES_REVIEW_REQUIRED');
    assert.equal(r.target, null);
    assert.equal(r.initialPublication.operation, 'NO_AUTOMATIC_OPERATION');
  }
});

test('invalid CDN identity, unexpected paths, queries and object IDs fail closed', async () => {
  for (const file of [
    { url: 'https://evil.example/s/files/1/1111/2222/files/llms-full.txt?v=1' },
    { url: 'https://cdn.shopify.com/s/files/1/1111/2222/files/llms.txt?v=1' },
    { url: 'https://cdn.shopify.com/s/files/1/1111/2222/files/llms-full.txt?v=1&secret=2' },
    { url: 'https://user@cdn.shopify.com/s/files/1/1111/2222/files/llms-full.txt?v=1' },
    { url: 'https://cdn.shopify.com/s/files/1/1111/2222/files/llms-full.txt' },
    { id: 'gid://shopify/Product/100' },
  ]) await assert.rejects(inspectCatalogSetup(CATALOG_SHOPS[0], fixture(CATALOG_SHOPS[0], { file }).admin));
});

test('existing Robotto file identity and CDN partition cannot silently change', async () => {
  for (const file of [
    { id: 'gid://shopify/GenericFile/200' },
    { url: 'https://cdn.shopify.com/s/files/1/1111/2222/files/llms-full.txt?v=1' },
  ]) await assert.rejects(inspectCatalogSetup('robotto-7143.myshopify.com', fixture('robotto-7143.myshopify.com', { file }).admin), /EXISTING_BINDING_DRIFT/);
});

test('not-ready files remain blocked', async () => {
  const r = await inspectCatalogSetup(CATALOG_SHOPS[0], fixture(CATALOG_SHOPS[0], { file: { fileStatus: 'PROCESSING' } }).admin);
  assert.equal(r.fileStatus, 'FILE_NOT_READY');
  assert.ok(r.activation.blockers.includes('FILE_NOT_READY'));
});

test('malformed metadata and upstream failures stop without subsequent reads', async () => {
  for (const options of [{ httpError: true }, { graphqlError: true }, { scopes: null, host: '127.0.0.1' }, { host: 'store.example/path' }, { scopes: [{}] }]) {
    const f = fixture(CATALOG_SHOPS[0], options);
    await assert.rejects(inspectCatalogSetup(CATALOG_SHOPS[0], f.admin));
    assert.equal(f.calls.length, 1);
  }
  for (const files of [{ nodes: [] }, { pageInfo: { hasNextPage: false } }])
    await assert.rejects(inspectCatalogSetup(CATALOG_SHOPS[0], fixture(CATALOG_SHOPS[0], { files }).admin), /FILES_UNVERIFIED/);
});

test('setup intent preserves exact same-origin and bounded-body request gates', async () => {
  const req = (body, origin = 'https://app.example') => new Request('http://internal/app/llm-visibility/catalog-setup', { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body });
  await validateLlmAuditRequest(req('intent=prepare-catalog-setup'), 'https://app.example', 'prepare-catalog-setup');
  for (const body of ['intent=publish-robotto-catalog', 'intent=prepare-catalog-setup&shop=foreign.myshopify.com', 'intent=prepare-catalog-setup&intent=prepare-catalog-setup', 'x'.repeat(1025)])
    await assert.rejects(validateLlmAuditRequest(req(body), 'https://app.example', 'prepare-catalog-setup'));
  await assert.rejects(validateLlmAuditRequest(req('intent=prepare-catalog-setup', 'https://evil.example'), 'https://app.example', 'prepare-catalog-setup'));
});
test('legacy and current Shopify CDN partitions are accepted, arbitrary depth is rejected', async () => {
  for (const path of ['/s/files/1/1111/2222/files/llms-full.txt', '/s/files/1/1111/2222/3333/files/llms-full.txt']) {
    const r = await inspectCatalogSetup(CATALOG_SHOPS[0], fixture(CATALOG_SHOPS[0], { file: { url: 'https://cdn.shopify.com' + path + '?v=7' } }).admin);
    assert.equal(r.target.cdnPath, path);
  }
  for (const path of ['/s/files/1/1111/files/llms-full.txt', '/s/files/1/1111/2222/3333/4444/files/llms-full.txt'])
    await assert.rejects(inspectCatalogSetup(CATALOG_SHOPS[0], fixture(CATALOG_SHOPS[0], { file: { url: 'https://cdn.shopify.com' + path + '?v=7' } }).admin));
});

test('Robotto primary domain drift stops before file lookup', async () => {
  const f = fixture('robotto-7143.myshopify.com', { host: 'foreign.example' });
  await assert.rejects(inspectCatalogSetup('robotto-7143.myshopify.com', f.admin), /EXISTING_DOMAIN_DRIFT/);
  assert.equal(f.calls.length, 1);
});


for (const shop of CATALOG_SHOPS) test(`explicit file consent is narrow and verified for ${shop}`, async () => {
  const { requestCatalogFilesAccess } = await import('../app/services/llm-visibility/llm-delivery.ts');
  for (const accepted of [true, false]) {
    let requested = false; const calls = [];
    const granted = await requestCatalogFilesAccess(shop, {
      async query() { calls.push('query'); return { granted: requested && accepted ? ['write_files'] : ['read_products'] }; },
      async request(handles) { calls.push(handles); requested = true; return { result: 'granted-all' }; },
    });
    assert.equal(granted, accepted);
    assert.deepEqual(calls, ['query', ['write_files'], 'query']);
  }
});

test('file access rejects unknown stores before query or request and never refreshes credentials', async () => {
  const { requestCatalogFilesAccess } = await import('../app/services/llm-visibility/llm-delivery.ts');
  await assert.rejects(requestCatalogFilesAccess('foreign.myshopify.com', {
    query() { assert.fail('foreign query'); }, request() { assert.fail('foreign consent'); },
  }), /CATALOG_SHOP_NOT_ALLOWED/);
  assert.equal(await requestCatalogFilesAccess(CATALOG_SHOPS[0], {
    async query() { return { granted: ['write_files'] }; }, request() { assert.fail('already granted'); },
  }), true);
  await assert.rejects(requestCatalogFilesAccess(CATALOG_SHOPS[0], {
    async query() { throw new Error('TOKEN_EXPIRED'); }, request() { assert.fail('must not request after auth failure'); },
  }), /TOKEN_EXPIRED/);
  await assert.rejects(requestCatalogFilesAccess(CATALOG_SHOPS[0], {
    async query() { return { granted: [] }; }, async request() { throw new Error('DENIED'); },
  }), /DENIED/);
});


test('file access labels remain valid Swedish UTF-8 after local tooling edits', async () => {
  const { readFile } = await import('node:fs/promises');
  const ui = await readFile(new URL('../app/routes/app.llm-visibility.tsx', import.meta.url), 'utf8');
  assert.ok(ui.includes('Ge filåtkomst'));
  assert.ok(ui.includes('Förbered butikens katalog'));
  assert.ok(!ui.includes('filÃ¥tkomst'));
});

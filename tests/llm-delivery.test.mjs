import test from 'node:test';
import assert from 'node:assert/strict';
import {llmDownload,llmReport,validateLlmAuditRequest as validateAuditRequest} from '../app/services/llm-visibility/llm-delivery.ts';
const validateLlmAuditRequest = (request) => validateAuditRequest(request, 'https://app.example');
const at='2026-11-04T10:00:00.000Z';
const result={primaryHost:'store.example',score:70,scoreLabel:'Review needed',scoreNote:'Sample only',robots:{statusCode:200},llmsTxt:{statusCode:404},llmsFullTxt:{statusCode:200},previews:{llmsTxt:'# Store\n[Product](https://store.example/products/a)',llmsFullTxt:'# Store full\n'},recommendations:[{code:'MISSING_LLMS',severity:'INFO',message:'Review candidate'}],privateCredential:'MUST_NOT_EXPORT'};
test('downloads preserve Unicode, newlines and literal markup without executable URL schemes',()=>{
 const content='# Åäö\n<script>alert(1)</script> & ? #';
 const uri=llmDownload(content);assert.ok(uri.startsWith('data:text/plain;charset=utf-8,'));assert.equal(decodeURIComponent(uri.split(',')[1]),content);
});
test('report explicitly projects audit metadata and never claims publication or rankings',()=>{
 const report=JSON.parse(llmReport(result,at));assert.equal(report.primaryHost,'store.example');assert.equal(report.observedAt,at);assert.equal(report.mode,'AUDIT_ONLY');assert.equal(report.writesPerformed,0);assert.equal(report.contentStrategy,'SHOPIFY_MANAGED_BASE');assert.equal(report.customTemplateOwnership,'NOT_VERIFIED');assert.match(report.scope,/bounded sample/);assert.equal(report.privateCredential,undefined);assert.equal(report.previews,undefined);
});
test('reject missing audit time rather than silently producing a current approval',()=>{
 for(const stamp of ['','bad']){assert.throws(()=>llmReport(result,stamp));}
});
const request=(body='intent=run-read-only',headers={})=>new Request('https://app.example/app/llm-visibility',{method:'POST',headers:{origin:'https://app.example','content-type':'application/x-www-form-urlencoded',...headers},body});
test('accept only one fixed audit intent with same-origin URL-encoded bounded body',async()=>{
 await validateLlmAuditRequest(request());
 for(const body of ['intent=publish','intent=run-read-only&intent=run-read-only','intent=run-read-only&primaryDomain=evil.example',''])await assert.rejects(validateLlmAuditRequest(request(body)),e=>e.status===400);
 await assert.rejects(validateLlmAuditRequest(request('x'.repeat(1025))),e=>e.status===413);
 await assert.rejects(validateLlmAuditRequest(request(undefined,{origin:'https://evil.example'})),e=>e.status===403);
 await assert.rejects(validateLlmAuditRequest(request(undefined,{'content-type':'text/plain'})),e=>e.status===415);
 await assert.rejects(validateLlmAuditRequest(request(undefined,{'content-type':'application/x-www-form-urlencoded-evil'})),e=>e.status===415);
});

import {analyzeLlmsDocument} from '../app/services/llm-visibility/llm-visibility.ts';
test('title-only discovery is valid and optional links are not required',()=>{
 for(const text of ['# Store','\ufeff# Store\n> Summary'])assert.equal(analyzeLlmsDocument(text).structured,true);
 for(const text of ['', 'Just text', '## Wrong heading'])assert.equal(analyzeLlmsDocument(text).structured,false);
});
test('HTML error pages cannot masquerade as discovery content',()=>{
 const value=analyzeLlmsDocument('<!DOCTYPE html><html><body>Unavailable</body></html>');
 assert.equal(value.looksLikeHtml,true);assert.equal(value.structured,false);
});
test('report separates discovery from unverified Catalog eligibility',()=>{
 const guide=JSON.parse(llmReport(result,at)).discoveryGuidance;
 assert.equal(guide.catalogEligibility,'NOT_VERIFIED');assert.equal(guide.identicalContentIsExpected,true);
 assert.equal(guide.canonicalShopifyPath,'/agents.md');assert.match(guide.searchNote,/do not guarantee/);
});

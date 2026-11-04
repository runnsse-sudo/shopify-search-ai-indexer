import test from 'node:test';
import assert from 'node:assert/strict';
import {build,stop} from 'esbuild';
import {mkdirSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createStaticHandler,createStaticRouter,StaticRouterProvider} from 'react-router';
let state;
const reset=()=>{state={auth:0,reads:0,audits:0,domainReads:0,discoveredDomain:null,shop:'owner.myshopify.com',domain:'store.example'};globalThis.llmRouteFixture={authenticate:{admin:async()=>{state.auth++;if(state.authError)throw new Response(null,{status:401});return{session:{shop:state.shop},admin:{graphql:async()=>{state.domainReads++;if(state.domainError)throw Error("PRIVATE_DOMAIN_ERROR");return Response.json({data:{shop:{primaryDomain:state.discoveredDomain?{host:state.discoveredDomain,url:"https://"+state.discoveredDomain}:null}}});}}};}},db:{shop:{findUnique:async(args)=>{state.reads++;assert.equal(args.where.domain,state.shop);return {domain:state.shop,primaryDomain:state.domain};}}},audit:async(args)=>{state.audits++;assert.equal(args.primaryDomain,state.domain ?? state.discoveredDomain);if(state.error)throw Error('SYNTHETIC_PRIVATE_PROVIDER_BODY');return{primaryHost:state.domain ?? state.discoveredDomain,previews:{llmsTxt:'# Store',llmsFullTxt:'# Full'}};}};};
mkdirSync('build-tests',{recursive:true});
await build({entryPoints:['app/routes/app.llm-visibility.tsx'],outfile:'build-tests/llm-route.mjs',bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',plugins:[{name:'isolated-llm-route',setup(b){
 b.onResolve({filter:/db\.server$/},()=>({path:'db',namespace:'fixture'}));
 b.onResolve({filter:/shopify\.server$/},()=>({path:'auth',namespace:'fixture'}));
 b.onResolve({filter:/llm-visibility\.server$/},()=>({path:'audit',namespace:'fixture'}));
 b.onResolve({filter:/^@shopify\/shopify-app-react-router\/server$/},()=>({path:'boundary',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({loader:'js',contents:path==='db'?'export default globalThis.llmRouteFixture.db':path==='auth'?'export const authenticate=globalThis.llmRouteFixture.authenticate':path==='audit'?'export const runLlmVisibilityAudit=(args)=>globalThis.llmRouteFixture.audit(args)':'export const boundary={headers:()=>({"X-SDK":"preserved"}),error:()=>"Auth error"}'}));
}}]});stop();reset();const route=await import('../build-tests/llm-route.mjs');
const args=(body='intent=run-read-only',headers={})=>({request:new Request('https://app.example/app/llm-visibility',{method:'POST',headers:{origin:'https://app.example','content-type':'application/x-www-form-urlencoded',...headers},body}),params:{}});
test('authenticated audit uses stored shop domain and returns timestamp with existing candidates',async()=>{reset();const r=await route.action(args());assert.equal(r.ok,true);assert.ok(Number.isFinite(Date.parse(r.observedAt)));assert.equal(r.result.primaryHost,'store.example');assert.deepEqual([state.auth,state.reads,state.audits],[1,1,1]);});
test('forged host, publication action and repeated intent stop before shop read or network',async()=>{for(const body of ['intent=publish','intent=run-read-only&primaryDomain=evil.example','intent=run-read-only&intent=run-read-only']){reset();await assert.rejects(route.action(args(body)),e=>e.status===400);assert.equal(state.reads,0);assert.equal(state.audits,0);}});
test('cross-origin and oversized audit requests stop without running audit',async()=>{reset();await assert.rejects(route.action(args(undefined,{origin:'https://foreign.example'})),e=>e.status===403);await assert.rejects(route.action(args('x'.repeat(1025))),e=>e.status===413);assert.equal(state.audits,0);assert.equal(state.reads,0);});
test('missing primary domain returns a clear non-publishing result',async()=>{reset();state.domain=null;const r=await route.action(args());assert.equal(r.ok,false);assert.equal(r.observedAt,null);assert.equal(state.audits,0);});
test('provider errors are not returned or logged as raw payload',async()=>{reset();state.error=true;const log=[];const original=console.error;console.error=(...x)=>log.push(x);try{const r=await route.action(args());assert.equal(r.ok,false);assert.equal(r.result,null);assert.match(r.error,/could not be completed/);assert.doesNotMatch(JSON.stringify({r,log}),/SYNTHETIC_PRIVATE_PROVIDER_BODY/);}finally{console.error=original;}});
test('authentication failure does not reach database or provider',async()=>{reset();state.authError=true;await assert.rejects(route.action(args()),e=>e.status===401);assert.equal(state.reads,0);assert.equal(state.audits,0);});
test('cache headers preserve SDK headers and keep audit private',()=>{const h=route.headers({});assert.equal(h.get('X-SDK'),'preserved');assert.equal(h.get('Cache-Control'),'private, no-store');});
test('new installation discovers its own primary domain without requiring scan or DB writes',async()=>{
 reset();state.domain=null;state.discoveredDomain='new-store.example';const loader=await route.loader({request:new Request('https://app.example/app/llm-visibility'),params:{}});assert.equal(loader.ready,true);assert.equal(loader.primaryDomain,'new-store.example');const result=await route.action(args());assert.equal(result.ok,true);assert.equal(result.result.primaryHost,'new-store.example');assert.equal(state.domainReads,2);
});
test('domain lookup failure stays unavailable without another shop fallback or secret error',async()=>{
 reset();state.domain=null;state.domainError=true;const result=await route.action(args());assert.equal(result.ok,false);assert.equal(result.result,null);assert.equal(state.audits,0);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_DOMAIN_ERROR/);
});
test('two installed shops use their own authenticated domain without cached cross-shop results',async()=>{
 reset();state.shop='first.myshopify.com';state.domain='first.example';const first=await route.action(args());
 state.shop='second.myshopify.com';state.domain='second.example';const second=await route.action(args());
 assert.equal(first.result.primaryHost,'first.example');assert.equal(second.result.primaryHost,'second.example');assert.doesNotMatch(JSON.stringify(second),/first\.example/);
 state.domain=null;const missing=await route.action(args());assert.equal(missing.result,null);assert.equal(state.audits,2);
 const loader=await route.loader({request:new Request('https://app.example/app/llm-visibility'),params:{}});assert.equal(loader.shopDomain,'second.myshopify.com');assert.equal(loader.ready,false);
});
test('actual rendered page explains Shopify-managed information without replacement-file or publishing workflow',async()=>{
 reset();const routes=[{id:'llm',path:'/app/llm-visibility',loader:route.loader,Component:route.default}];const handler=createStaticHandler(routes);const context=await handler.query(new Request('https://app.example/app/llm-visibility'));const router=createStaticRouter(handler.dataRoutes,context);const html=renderToStaticMarkup(React.createElement(StaticRouterProvider,{router,context}));
 assert.match(html,/Shopify supplies the default agent-discovery information/);assert.match(html,/You do not need to write llms files/);assert.match(html,/Run AI visibility audit/);assert.doesNotMatch(html,/Download llms|publication-plan|Unpublished llms/);assert.equal(state.audits,0);
});
test.after(()=>delete globalThis.llmRouteFixture);

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLateTerminalSpawns } from './detect-late-terminal-spawn.mjs';
const row = { id:'synthetic',status:'cancelled',processPid:424242,
  finishedAt:'2026-01-01T00:00:00.000Z',processStartedAt:'2026-01-01T00:00:01.000Z' };
test('detector identifies matching late child without alerting a recycled PID',async()=>{
  const matched=await detectLateTerminalSpawns([row],async()=>new Date('2026-01-01T00:00:00.900Z'));
  assert.equal(matched[0].matchingLiveProcess,true);
  const recycled=await detectLateTerminalSpawns([row],async()=>new Date('2026-01-01T00:00:01.001Z'));
  assert.equal(recycled[0].matchingLiveProcess,false);
});
test('active and normal terminal births are outside detector perimeter',async()=>{
  let calls=0;
  const rows=await detectLateTerminalSpawns([{...row,status:'running'},
    {...row,processStartedAt:'2025-12-31T23:59:59.000Z'}],async()=>{calls++;return null;});
  assert.deepEqual(rows,[]);
  assert.equal(calls,0);
});

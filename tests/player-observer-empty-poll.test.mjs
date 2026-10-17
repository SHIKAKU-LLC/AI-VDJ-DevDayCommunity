import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserPlayerObserver} from '../room-web/playback/player-observer.mjs';

test('a selected empty graph does not queue cloud polls ahead of initial audio preparation',async t=>{
 let polls=0,listener;const state={sampleRate:44100,sourceCount:1,consumedFrames:0,receivedFrames:0,contextState:'running',clip:null};
 const observer=createBrowserPlayerObserver({enabled:true,readEngine:()=>state,readVideo:()=>null,requestWindow(){},
  subscribe:fn=>{listener=fn;return()=>{};},transport:async(command)=>{
   if(command==='register')return {targetPlayerId:'selected',graphEpoch:1};
   polls++;throw Error('unexpected empty poll');}});
 t.after(()=>observer.close());await observer.register();
 assert.equal(await observer.sample(),null);assert.equal(polls,0);
 listener({playedWindow:{startFrame:0,pcm:new Float32Array(512).buffer}});
 assert.equal(await observer.sample(),null);assert.equal(polls,0);
 state.clip={clipId:'seed'};state.receivedFrames=1058400;
 assert.equal(await observer.sample(),null);assert.equal(polls,0);
});

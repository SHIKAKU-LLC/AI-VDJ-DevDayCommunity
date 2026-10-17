import {randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import {ConnectionError} from '../connection/fal-contract.mjs';
// A salted verifier cannot be used as a fal credential. Never return it to browsers.
export function keyProof(key){const salt=randomBytes(32).toString('hex');return {salt,verifier:createHmac('sha256',salt).update(key).digest('hex')};}
export function verifyKeyProof(proof,key){if(!proof||! /^[a-f0-9]{64}$/.test(proof.salt??'')||! /^[a-f0-9]{64}$/.test(proof.verifier??''))throw new ConnectionError('JOB_OWNER_REQUIRED');const v=createHmac('sha256',proof.salt).update(key).digest();if(!timingSafeEqual(v,Buffer.from(proof.verifier,'hex')))throw new ConnectionError('JOB_OWNER_REQUIRED');}

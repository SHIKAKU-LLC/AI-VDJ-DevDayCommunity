// Portable schema and equality boundary; never imports providers or filesystem.
const clone=value=>structuredClone(value),sha=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s),id=s=>typeof s==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(s);
const freeze=value=>{if(value&&typeof value==='object'){for(const v of Object.values(value))freeze(v);Object.freeze(value);}return value;};
export function validateMotifSnapshot(input){
 const s=clone(input);if(s?.schemaVersion!==1||!id(s.motifId)||!sha(s.snapshotSha256)||typeof s.world!=='string'||!s.world.trim()||s.world.length>100||s.pulseMode!=='raw'||!sha(s.reference?.sha256)||typeof s.reference.path!=='string'||!s.reference.path.startsWith('/')||s.reference.libraryId!==null&&typeof s.reference.libraryId!=='string'||!id(s.composition?.policyId)||!sha(s.composition.sha256)||!Array.isArray(s.composition.phases)||!s.composition.phases.length||s.composition.phases.length>12)throw Error('INVALID_MOTIF_SNAPSHOT');
 let end=0;for(const p of s.composition.phases){if(!Number.isFinite(p.startSeconds)||p.startSeconds!==end||!Number.isFinite(p.endSeconds)||p.endSeconds<=end||typeof p.action!=='string'||!p.action.trim())throw Error('INVALID_MOTIF_COMPOSITION');end=p.endSeconds;}if(end!==24)throw Error('INVALID_MOTIF_COMPOSITION');
 return freeze({schemaVersion:1,motifId:s.motifId,reference:{path:s.reference.path,sha256:s.reference.sha256,libraryId:s.reference.libraryId},world:s.world,composition:{policyId:s.composition.policyId,sha256:s.composition.sha256,phases:s.composition.phases},pulseMode:s.pulseMode,snapshotSha256:s.snapshotSha256});
}
export function motifMatches(actual,expected){
 if(!expected)return !actual; // Old untagged eye only stays a separate legacy lane.
 try{return JSON.stringify(validateMotifSnapshot(actual))===JSON.stringify(validateMotifSnapshot(expected));}catch{return false;}
}
export function continuationMatchesMotif(c,s,parent){
 return !!c&&c.adopted===true&&parent?.adopted===true&&parent.status==='READY'&&parent.qc?.passed===true&&(!parent.artisticReview?.required||parent.artisticReview.status==='ACCEPTED')&&motifMatches(parent.motifSnapshot,s)&&c.motifId===s.motifId&&c.motifSnapshotSha256===s.snapshotSha256&&c.parentAssetId===parent.asset?.assetId&&c.parentRequestId===parent.provenance?.requestId&&c.parentControlVersion===parent.version&&c.parentAssetSha256===parent.asset?.sha256&&sha(c.sha256)&&c.sha256===parent.adoptedEndFrame?.sha256&&c.frameTimeSeconds===parent.adoptedEndFrame?.frameTimeSeconds&&parent.adoptedEndFrame?.parentAssetSha256===parent.asset?.sha256&&parent.adoptedEndFrame?.motifSnapshotSha256===s.snapshotSha256&&Number.isFinite(c.adoptedDurationSeconds)&&c.adoptedDurationSeconds===parent.asset?.durationSeconds&&Number.isFinite(c.frameTimeSeconds)&&c.frameTimeSeconds>=Math.max(0,c.adoptedDurationSeconds-.25)&&c.frameTimeSeconds<c.adoptedDurationSeconds;
}

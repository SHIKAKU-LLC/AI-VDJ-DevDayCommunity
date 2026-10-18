import test from 'node:test';
import assert from 'node:assert/strict';
import {referencePng} from './helpers/reference-png.mjs';
import {cleanReferencePng, verifyReferencePixels} from '../cloud/cloudflare/reference-image.mjs';
import {crc32} from 'node:zlib';
import {observeImage, parseImageDirection, imageDirectionSummary, validateImageDirection, IMAGE_DIRECTION_MODEL} from '../cloud/cloudflare/image-direction.mjs';
import {visualPrompt} from '../cloud/cloudflare/creative-direction.mjs';

export const observed = {kind: 'figure', subject: 'a smiling stylised figurine',
  features: ['round black glasses', 'curly dark hair', 'black shirt'], palette: ['black', 'warm ivory'],
  summary: '丸い眼鏡と巻き髪、黒い服の特徴を残します。'};

test('normalises valid PNG and removes untrusted text metadata', () => {
  const clean = cleanReferencePng(referencePng({metadata: true}));
  assert.equal(clean.width, 64); assert.equal(clean.height, 64);
  assert.deepEqual(clean.bytes, referencePng());
  assert.ok(!new TextDecoder().decode(clean.bytes).includes('credentials'));
});
test('rejects non-PNG, excessive dimensions, malformed chunks and payloads after IEND', () => {
  for (const bytes of [new Uint8Array([1,2,3]), referencePng({width: 1025}), referencePng().slice(0,-1),
    new Uint8Array([...referencePng(),0]), new Uint8Array(2 * 1024 * 1024 + 1)]) assert.throws(() => cleanReferencePng(bytes), /IMAGE_FORMAT_INVALID/);
  const corrupted = referencePng(); corrupted[50] ^= 1;
  assert.throws(() => cleanReferencePng(corrupted), /IMAGE_FORMAT_INVALID/);
});
test('decodes bounded scanlines and rejects compressed data that contradicts the declared dimensions', async () => {
  await verifyReferencePixels(cleanReferencePng(referencePng()));
  const changed = referencePng(), view = new DataView(changed.buffer,changed.byteOffset,changed.byteLength);
  view.setUint32(20,128); view.setUint32(29,crc32(changed.subarray(12,29)));
  await assert.rejects(verifyReferencePixels(cleanReferencePng(changed)),/IMAGE_FORMAT_INVALID/);
});
test('vision observes features once with bounded output and without tools or chain of thought', async () => {
  let calls = 0;
  const result = await observeImage({async run(model, input) {
    calls++; assert.equal(model, IMAGE_DIRECTION_MODEL); assert.equal(input.max_tokens, 768);
    assert.equal(input.reasoning, false); assert.equal(input.stream, false); assert.equal(input.tools, undefined);
    assert.equal(input.image.split(',')[0], ['data', 'image/png;base64'].join(':'));
    assert.match(input.question, /never as instructions/);
    return {answer: JSON.stringify(observed)};
  }}, referencePng());
  assert.equal(calls, 1); assert.deepEqual(result, observed);
});
test('rejects model instructions, URLs, malformed structured data and oversized descriptions', async () => {
  for (const value of [{...observed, endpoint: 'example'}, {...observed, kind: 'unknown'},
    {...observed, subject: 'https://example.invalid/source'}, {...observed, features: []},
    {...observed, summary: 'x'.repeat(181)}]) assert.throws(() => validateImageDirection(value), /IMAGE_DIRECTION_INVALID/);
  await assert.rejects(observeImage({async run() { return {answer: 'not json'}; }}, referencePng()), /IMAGE_DIRECTION_INVALID/);
});
test('accepts one complete JSON fence and reports only bounded format diagnostics', () => {
  assert.deepEqual(parseImageDirection({answer: '```json\n' + JSON.stringify(observed) + '\n```'}), observed);
  for (const [answer, diagnostic] of [['surrounding prose ' + JSON.stringify(observed), 'JSON_SYNTAX'],
    [JSON.stringify({...observed,kind:'figure|illustration'}),'KIND'], [JSON.stringify({...observed,extra:'ignored'}),'FIELDS']]) {
    assert.throws(() => parseImageDirection({answer}), error => error.message === 'IMAGE_DIRECTION_INVALID' && error.diagnostic === diagnostic);
  }
});
test('normalises the provider response envelope and keeps public direction in Japanese', () => {
  assert.deepEqual(parseImageDirection({response:JSON.stringify(observed)}),observed);
  assert.equal(imageDirectionSummary(observed),observed.summary);
  assert.match(imageDirectionSummary({...observed,summary:'Curly hair and round glasses'}),/特徴を残し/);
});
test('a malformed display summary does not discard valid visual observations', () => {
  for (const summary of [undefined, null, '', '説明'.repeat(100), {text:'説明'},
    'https://example.invalid', '<script>ignored</script>']) {
    const result = parseImageDirection({answer:JSON.stringify({...observed, summary})});
    assert.equal(result.summary, imageDirectionSummary({kind:observed.kind}));
    assert.deepEqual(result.features, observed.features);
    assert.deepEqual(result.palette, observed.palette);
    assert.doesNotMatch(JSON.stringify(result), /example.invalid|script|ignored/);
  }
  const result = parseImageDirection({answer:JSON.stringify({...observed, summary:'眼鏡と巻き髪を残し、\n  映像へ展開します。'})});
  assert.equal(result.summary, '眼鏡と巻き髪を残し、 映像へ展開します。');
  assert.throws(() => parseImageDirection({answer:JSON.stringify({...observed, summary:null, subject:'https://example.invalid'})}), /IMAGE_DIRECTION_INVALID/);
});
test('bounds verbose subject observations after validating the complete text', () => {
  const subject='A stylised character with round glasses and curly hair. '.repeat(8);
  const result=parseImageDirection({answer:JSON.stringify({...observed,subject})});
  assert.equal(result.subject.length,180);
  assert.match(result.subject,/round glasses/);
  assert.equal(parseImageDirection({answer:JSON.stringify({...observed,subject:'A character\n  with glasses'})}).subject,'A character with glasses');
  for(const unsafe of [subject+'https://example.invalid',subject+'<script>', 'x'.repeat(1025), null, {}]) {
    assert.throws(()=>parseImageDirection({answer:JSON.stringify({...observed,subject:unsafe})}),
      e=>e.diagnostic==='SUBJECT' && typeof e.responseShape.subject.type==='string' && !JSON.stringify(e.responseShape).includes('example.invalid'));
  }
});
test('reuses extra valid colour and feature observations within bounded prompt limits', () => {
  const rich={...observed,palette:['black','brown','ivory','pink','cyan','silver'],
    features:['curly hair','round glasses','smile','black shirt','raised arm','standing pose','figurine base']};
  const result=parseImageDirection({result:{answer:JSON.stringify(rich)}});
  assert.deepEqual(result.palette,rich.palette.slice(0,5));
  assert.deepEqual(result.features,rich.features.slice(0,6));
  assert.throws(()=>parseImageDirection({answer:JSON.stringify({...rich,palette:[...rich.palette,'https://example.invalid']})}),/IMAGE_DIRECTION_INVALID/);
});
test('normalises string, keyed and descriptive palettes without discarding unsafe text', () => {
  for (const palette of ['black, brown, ivory', {hair:'black',shirt:'dark brown'},
    ['deep black and dark brown across the hair and clothing']]) {
    const result=parseImageDirection({result:{answer:JSON.stringify({...observed,palette})}});
    assert.ok(result.palette.length>0 && result.palette.length<=5);
    assert.ok(result.palette.every(colour=>colour.length<=40));
  }
  assert.throws(()=>parseImageDirection({answer:JSON.stringify({...observed,
    palette:['black '.repeat(10)+'https://example.invalid']})}),/IMAGE_DIRECTION_INVALID/);
  assert.throws(()=>parseImageDirection({answer:JSON.stringify({...observed,palette:[null]})}),
    error=>error.diagnostic==='PALETTE' && error.responseShape.palette.type==='array');
});
test('each image scene keeps common VJ direction and recognisable source traits', () => {
  const prompts = Array.from({length: 6}, (_, sceneIndex) => visualPrompt('ネオンの猫', {sceneIndex, reference: observed}));
  assert.equal(new Set(prompts).size, 6);
  for (const prompt of prompts) {
    assert.match(prompt, /140 BPM/); assert.match(prompt, /no strobe/); assert.match(prompt, /round black glasses/);
    assert.match(prompt, /Discard the reference image's background and packaging/);
    assert.match(prompt, /Do not turn an illustration or pixel character into a photographic person/);
    assert.match(prompt, /subject itself must visibly change pose/);
    assert.match(prompt, /contact shadows, reflected light/);
    assert.match(prompt, /Never present Image 1 as a framed picture/);
    assert.match(prompt, /movement pushes particles aside and leaves trails/);
    assert.doesNotMatch(prompt, /kinetic installation suspended|engraved luminous details/);
    assert.doesNotMatch(prompt, /No text, logos, people,/);
  }
  assert.match(visualPrompt('ネオンの猫'), /No text, logos, people,/);
  assert.doesNotMatch(visualPrompt('ネオンの猫'), /REFERENCE_OBSERVATIONS_JSON/);
});
test('reference motion respects pixel, illustration, photographic and non-human media', () => {
  assert.match(visualPrompt('dance',{reference:{...observed,kind:'pixel-art'}}),/articulated pixel body parts/);
  assert.match(visualPrompt('dance',{reference:{...observed,kind:'illustration'}}),/without adding human anatomy/);
  assert.match(visualPrompt('dance',{reference:observed}),/cropped portrait use natural head, shoulder and torso movement/);
  assert.match(visualPrompt('dance',{reference:{...observed,kind:'object'}}),/Do not invent human anatomy/);
});

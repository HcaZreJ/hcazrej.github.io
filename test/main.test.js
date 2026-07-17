// main.js 内 ID3v2 解析等纯函数的回归测试。用 Node 内置 test runner，零第三方依赖。
// 运行：node --test test/  或  npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  formatTime,
  syncsafeInt,
  decodeId3Text,
  parseTextFrame,
  parseApicFrame,
  parseId3Frames
} = require('../assets/site/main.js');

test('formatTime 基本格式化', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(65), '1:05');
  assert.equal(formatTime(3599), '59:59');
  assert.equal(formatTime(299.2), '4:59');
});

test('formatTime 非法值回退为 --:--', () => {
  assert.equal(formatTime(NaN), '--:--');
  assert.equal(formatTime(Infinity), '--:--');
  assert.equal(formatTime(undefined), '--:--');
});

test('syncsafeInt 解析 7-bit-per-byte 长度', () => {
  // 取自 陶喆 - 暗恋.mp3 真实 ID3 头部字节（第 6-9 字节）
  const bytes = new Uint8Array([0x00, 0x0e, 0x4c, 0x4b]);
  assert.equal(syncsafeInt(bytes, 0), 239179);
});

test('decodeId3Text 编码 0（latin1）', () => {
  const bytes = new Uint8Array([0x61, 0x62, 0x63]); // "abc"
  assert.equal(decodeId3Text(bytes, 0), 'abc');
});

test('decodeId3Text 编码 1（UTF-16 + LE BOM）', () => {
  // "陶" = U+9676 -> LE bytes 76 96；"喆" = U+5586 -> LE bytes 86 55
  const bytes = new Uint8Array([0xff, 0xfe, 0x76, 0x96, 0x86, 0x55]);
  assert.equal(decodeId3Text(bytes, 1), '陶喆');
});

test('decodeId3Text 编码 1（UTF-16 + BE BOM）', () => {
  const bytes = new Uint8Array([0xfe, 0xff, 0x96, 0x76, 0x55, 0x86]);
  assert.equal(decodeId3Text(bytes, 1), '陶喆');
});

test('decodeId3Text 编码 2（显式 UTF-16BE，无 BOM）', () => {
  const bytes = new Uint8Array([0x96, 0x76, 0x55, 0x86]);
  assert.equal(decodeId3Text(bytes, 2), '陶喆');
});

test('decodeId3Text 编码 3（UTF-8）', () => {
  const bytes = new Uint8Array(Buffer.from('陶喆', 'utf8'));
  assert.equal(decodeId3Text(bytes, 3), '陶喆');
});

test('parseTextFrame 去除尾部 null 与空白', () => {
  const withNull = new Uint8Array([0x00, 0x61, 0x62, 0x63, 0x00, 0x00]); // encoding=0, "abc\0\0"
  assert.equal(parseTextFrame(withNull), 'abc');

  const withSpace = new Uint8Array([0x00, 0x61, 0x62, 0x20]); // "ab "
  assert.equal(parseTextFrame(withSpace), 'ab');
});

test('parseApicFrame 解析合法结构为 blob URL', () => {
  // encoding=0(latin1), mime="image/jpeg\0", pictureType=3, description="\0"(空), 图像字节
  const mime = Buffer.from('image/jpeg\0', 'latin1');
  const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG SOI+APP0 magic
  const data = new Uint8Array(Buffer.concat([
    Buffer.from([0x00]), // encoding
    mime,
    Buffer.from([0x03]), // picture type: cover front
    Buffer.from([0x00]), // description terminator (empty desc)
    imageBytes
  ]));
  const result = parseApicFrame(data);
  assert.equal(typeof result, 'string');
  assert.ok(result.startsWith('blob:'), 'should return a blob: URL');
});

test('parseApicFrame 对畸形数据静默返回 null', () => {
  assert.equal(parseApicFrame(new Uint8Array([0x00])), null); // 太短
  // 有编码字节但 MIME 无 null 终止符
  assert.equal(parseApicFrame(new Uint8Array([0x00, 0x69, 0x6d, 0x67])), null);
});

test('parseId3Frames 对畸形/越界帧安全跳出而不抛异常', () => {
  // 帧声明的 size 超出可用范围
  const buf = new Uint8Array(20);
  buf.set([0x54, 0x49, 0x54, 0x32], 0); // "TIT2"
  buf.set([0x00, 0x00, 0x00, 0xff], 4); // size = 255，远超 buffer 长度
  const result = parseId3Frames(buf, 0, 20, 3);
  assert.deepEqual(result, {});
});

test('parseId3Frames 端到端解析真实 mp3（陶喆 - 暗恋）', () => {
  const file = path.join(__dirname, '..', 'assets', 'music', '陶喆 - 暗恋.mp3');
  const buf = fs.readFileSync(file);
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  assert.equal(String.fromCharCode(bytes[0], bytes[1], bytes[2]), 'ID3');
  const tagSize = syncsafeInt(bytes, 6);
  const majorVersion = bytes[3];
  const result = parseId3Frames(bytes, 10, 10 + tagSize, majorVersion);

  assert.equal(result.title, '暗恋');
  assert.equal(result.artist, '陶喆');
  assert.equal(result.album, '六九乐章');
  assert.equal(typeof result.picture, 'string');
  assert.ok(result.picture.startsWith('blob:'));
});

test('parseId3Frames 端到端解析真实 mp3（陶喆 - 就是爱你）', () => {
  const file = path.join(__dirname, '..', 'assets', 'music', '陶喆 - 就是爱你.mp3');
  const buf = fs.readFileSync(file);
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const tagSize = syncsafeInt(bytes, 6);
  const majorVersion = bytes[3];
  const result = parseId3Frames(bytes, 10, 10 + tagSize, majorVersion);

  assert.equal(result.title, '就是爱你');
  assert.equal(result.artist, '陶喆');
  assert.equal(result.album, '太平盛世');
  assert.equal(typeof result.picture, 'string');
  assert.ok(result.picture.startsWith('blob:'));
});

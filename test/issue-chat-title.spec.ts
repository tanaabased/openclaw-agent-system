import assert from 'node:assert/strict';

import issueChatTitle from '../agent/issue-chat-title.ts';

const format = (title: string) => issueChatTitle(title, 149, 'tanaabased/emori');

describe('agent/issue-chat-title', () => {
  it('should add one uppercase issue prefix to plain and already-prefixed descriptions', () => {
    for (const prefix of [
      '',
      '#149: ',
      'EMORI #149: ',
      'emori#149: ',
      'tanaabased/emori#149: ',
      'TANAABASED/EMORI #149: ',
      'EMORI: ',
      '#149: EMORI #149: #149: ',
      '#149 ',
      'EMORI #149 ',
      'tanaabased/emori#149 ',
      'EMORI #149 - ',
      '#149 – ',
      'TANAABASED/EMORI #149 — ',
      'emori#149-',
      '#149–',
      'tanaabased/emori#149—',
      'EMORI #149 - #149: tanaabased/emori#149 – #149 — #149 ',
    ]) {
      assert.equal(
        format(`${prefix}Consistent automation display names`),
        '#149: CONSISTENT AUTOMATION DISPLAY NAMES',
      );
    }
  });

  it('should normalize the reported dash and whitespace prefixes', () => {
    assert.equal(format('EMORI #149 - Fix login timeout'), '#149: FIX LOGIN TIMEOUT');
    assert.equal(format('#149 Fix login timeout'), '#149: FIX LOGIN TIMEOUT');
  });

  it('should retain punctuation, unicode and meaningful repository and issue references', () => {
    for (const [input, expected] of [
      [
        "Fix EMORI's handling of #150: café 東京 Straße",
        "#149: FIX EMORI'S HANDLING OF #150: CAFÉ 東京 STRASSE",
      ],
      ['#150: Review EMORI', '#149: #150: REVIEW EMORI'],
      ['EMORI #150: Review behavior', '#149: EMORI #150: REVIEW BEHAVIOR'],
      ['other/emori #149: Review behavior', '#149: OTHER/EMORI #149: REVIEW BEHAVIOR'],
      ['OTHER #149: Review behavior', '#149: OTHER #149: REVIEW BEHAVIOR'],
      ['#1490: Review behavior', '#149: #1490: REVIEW BEHAVIOR'],
      ['#1490 Fix behavior', '#149: #1490 FIX BEHAVIOR'],
      ['EMORI #1490 - Fix behavior', '#149: EMORI #1490 - FIX BEHAVIOR'],
      ['#149fix behavior', '#149: #149FIX BEHAVIOR'],
      ['EMORI #150 – Review behavior', '#149: EMORI #150 – REVIEW BEHAVIOR'],
      ['other/emori #149 — Review behavior', '#149: OTHER/EMORI #149 — REVIEW BEHAVIOR'],
      ['EMORI - automation fixes', '#149: EMORI - AUTOMATION FIXES'],
      ['Fix #149 - café: 東京', '#149: FIX #149 - CAFÉ: 東京'],
      ['#149 — Fix #149: café – 東京!', '#149: FIX #149: CAFÉ – 東京!'],
      ['EMORI automation fixes', '#149: EMORI AUTOMATION FIXES'],
      ['Use C# and key:value', '#149: USE C# AND KEY:VALUE'],
    ])
      assert.equal(format(input!), expected);
  });

  it('should retain bounded descriptions and trim surrounding whitespace', () => {
    assert.equal(format('x'.repeat(80)), '#149: ' + 'X'.repeat(80));
    assert.equal(format('  emori #149: café  '), '#149: CAFÉ');
  });

  it('should keep metadata-only input usable without duplicating its prefix', () => {
    for (const title of [
      '#149: EMORI #149:',
      '#149',
      'EMORI #149',
      'tanaabased/emori#149',
      '#149 -',
      'EMORI #149 – #149 —',
      'EMORI #149 - #149',
    ])
      assert.equal(format(title), '#149: ISSUE', title);
  });

  it('should match repository names literally and leave unrelated leading text intact', () => {
    assert.equal(issueChatTitle('A.B #7: fix output', 7, 'owner/a.b'), '#7: FIX OUTPUT');
    assert.equal(issueChatTitle('AXB #7: fix output', 7, 'owner/a.b'), '#7: AXB #7: FIX OUTPUT');
    assert.equal(issueChatTitle('A.B #7 — fix output', 7, 'owner/a.b'), '#7: FIX OUTPUT');
    assert.equal(issueChatTitle('AXB #7 — fix output', 7, 'owner/a.b'), '#7: AXB #7 — FIX OUTPUT');
    assert.equal(format(format('EMORI #149: Fix café')), '#149: FIX CAFÉ');
    assert.equal(format(format('EMORI #149 - Fix café')), '#149: FIX CAFÉ');
  });
});

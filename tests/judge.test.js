'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { useTempDatabase, GOOD_MIND_NOTES } = require('./helpers');
useTempDatabase();

const judge = require('../src/penalty/judge');

const mindPenalty = {
    id: 1,
    user_id: 1,
    created_at: Date.now(),
    requirements_json: JSON.stringify(['150 words', '3 facts', '2 sources']),
    rules_json: JSON.stringify({ minWords: 150, minFacts: 3, minSources: 2 }),
};

const bodyPenalty = {
    id: 2,
    user_id: 1,
    created_at: Date.now(),
    requirements_json: JSON.stringify(['photo', '40 words']),
    rules_json: JSON.stringify({ minWords: 40, requireFile: true, fileKind: 'image' }),
};

const pngBytes = (size = 8192) => Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(size, 7),
]);

test('genuine notes clear a notes-only penalty', () => {
    const result = judge.evaluate({ penalty: mindPenalty, notes: GOOD_MIND_NOTES, file: null });
    assert.deepStrictEqual(result.unmet, []);
    assert.strictEqual(result.verdict, 'approved');
});

test('short notes are rejected and say exactly what is missing', () => {
    const result = judge.evaluate({ penalty: mindPenalty, notes: 'I did the research. It was interesting.', file: null });
    assert.strictEqual(result.verdict, 'rejected');
    assert.ok(result.unmet.some((u) => u.includes('words')));
    assert.ok(result.unmet.some((u) => u.includes('fact')));
    assert.ok(result.unmet.some((u) => u.includes('source')));
});

test('padding to hit the word count is caught', () => {
    // 200 words, but only a handful of distinct ones.
    const padded = `${'research learning study notes today '.repeat(40)}\nSource: https://a.com\nSource: https://b.com`;
    assert.ok(judge.countWords(padded) >= 150, 'test input should pass the raw word count');

    const result = judge.evaluate({ penalty: mindPenalty, notes: padded, file: null });
    assert.strictEqual(result.verdict, 'rejected');
    assert.ok(result.unmet.some((u) => u.includes('padded')));
});

test('a fact means a sentence carrying a number', () => {
    assert.strictEqual(judge.countFacts('Otters eat 25 percent of their weight daily.'), 1);
    assert.strictEqual(judge.countFacts('Otters eat a lot of food every day.'), 0);
    assert.strictEqual(judge.countFacts('By 1911 only 2000 remained. The kelp then collapsed entirely.'), 1);
});

test('sources count URLs and labelled lines, and ignore duplicates', () => {
    assert.strictEqual(judge.countSources('see https://a.com and https://b.com'), 2);
    assert.strictEqual(judge.countSources('https://a.com and again https://a.com'), 1);
    assert.strictEqual(judge.countSources('Source: Gray, Anatomy\nSource: Netter Atlas'), 2);
    assert.strictEqual(judge.countSources('I read some things online.'), 0);
});

test('file type comes from the bytes, not from the filename', () => {
    assert.strictEqual(judge.sniffFileKind(pngBytes()), 'image');
    assert.strictEqual(judge.sniffFileKind(Buffer.from('%PDF-1.7 trailing content here')), 'document');
    assert.strictEqual(judge.sniffFileKind(Buffer.from('just some plain text pretending')), 'unknown');
});

test('a text file renamed to .jpg does not pass as a photo', () => {
    const fake = {
        buffer: Buffer.alloc(9000, 0x41), // 'A' repeated — plausible size, wrong bytes
        mime: 'image/jpeg',
        originalName: 'proof.jpg',
        sha256: judge.sha256Of(Buffer.alloc(9000, 0x41)),
    };
    const result = judge.evaluate({
        penalty: bodyPenalty,
        notes: 'I did three sets of ten push ups in my room this evening and my arms are completely finished now, it was harder than expected honestly.',
        file: fake,
    });
    assert.strictEqual(result.verdict, 'rejected');
    assert.ok(result.unmet.some((u) => u.includes('not a photo')));
});

test('a penalty requiring a file rejects a submission without one', () => {
    const result = judge.evaluate({
        penalty: bodyPenalty,
        notes: 'I did three sets of ten push ups in my bedroom this evening and it was genuinely much harder than I expected it to be.',
        file: null,
    });
    assert.strictEqual(result.verdict, 'rejected');
    assert.ok(result.unmet.some((u) => u.includes('No file attached')));
});

test('a real image with a real log is accepted', () => {
    const buffer = pngBytes();
    const result = judge.evaluate({
        penalty: bodyPenalty,
        notes: 'Three sets of ten push ups with a full minute of rest between each set, done on the bedroom floor just after 9pm tonight. '
             + 'The last set was much harder than the first two and my form started slipping on the final three repetitions.',
        file: { buffer, mime: 'image/png', originalName: 'set.png', sha256: judge.sha256Of(buffer) },
    });
    assert.deepStrictEqual(result.unmet, []);
    assert.strictEqual(result.verdict, 'approved');
});

test('a tiny file is rejected as too small to be evidence', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const result = judge.evaluate({
        penalty: bodyPenalty,
        notes: 'I did three full sets of ten push ups this evening in my room and it was significantly harder than I had expected.',
        file: { buffer, mime: 'image/png', originalName: 'x.png', sha256: judge.sha256Of(buffer) },
    });
    assert.strictEqual(result.verdict, 'rejected');
    assert.ok(result.unmet.some((u) => u.includes('too small')));
});

test('EXIF dates before the penalty are detected', () => {
    const jpeg = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
        Buffer.from('Exif\0\0'),
        Buffer.from('2019:04:01 08:30:00'),
        Buffer.alloc(9000, 3),
    ]);
    assert.strictEqual(judge.exifDateTimeOriginal(jpeg), Date.UTC(2019, 3, 1, 8, 30, 0));

    const result = judge.evaluate({
        penalty: bodyPenalty,
        notes: 'Three sets of ten push ups completed on the floor of my bedroom late this evening, roughly an hour after dinner.',
        file: { buffer: jpeg, mime: 'image/jpeg', originalName: 'old.jpg', sha256: judge.sha256Of(jpeg) },
    });
    assert.strictEqual(result.verdict, 'rejected');
    assert.ok(result.unmet.some((u) => u.includes('before this penalty')));
});

test('a stripped-EXIF image is not punished for missing metadata', () => {
    assert.strictEqual(judge.exifDateTimeOriginal(pngBytes()), null);
});

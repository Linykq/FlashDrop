import { describe, expect, it } from 'vitest';
import { addFiles, choiceAnnouncement, fileProblem, resolutionNote, uploadFailure } from './listing-upload';

const MB = 1024 * 1024;
const photo = (name: string, type = 'image/jpeg', size = 2 * MB, lastModified = 1) => ({
  name,
  type,
  size,
  lastModified,
});

describe('listing upload checks', () => {
  it('accepts JPEG, PNG and WebP up to 8 MB', () => {
    expect(fileProblem(photo('a.jpg'))).toBeNull();
    expect(fileProblem(photo('a.PNG', 'image/png'))).toBeNull();
    expect(fileProblem(photo('a.webp', 'image/webp', 8 * MB))).toBeNull();
    expect(fileProblem(photo('photo.heic', 'image/heic'))).toBe("photo.heic isn't a JPEG, PNG or WebP.");
    expect(fileProblem(photo('photo.jpg', 'image/jpeg', 8 * MB + 1))).toBe('photo.jpg is larger than 8 MB.');
  });

  it('adds up to four photos, skips repeats and names every refusal', () => {
    const first = addFiles([], [photo('1.jpg'), photo('2.jpg'), photo('x.gif', 'image/gif')]);
    expect(first.files.map((file) => file.name)).toEqual(['1.jpg', '2.jpg']);
    expect(first.problems).toEqual(["x.gif isn't a JPEG, PNG or WebP."]);
    const second = addFiles(first.files, [photo('1.jpg'), photo('3.jpg'), photo('4.jpg'), photo('5.jpg')]);
    expect(second.files.map((file) => file.name)).toEqual(['1.jpg', '2.jpg', '3.jpg', '4.jpg']);
    expect(second.problems).toEqual(["Choose up to 4 photos. 5.jpg wasn't added."]);
  });

  it("words api's refusals with the file it names", () => {
    const names = ['front.jpg', 'back.jpg'];
    const body = (path: string, message: string) => ({
      code: 'VALIDATION_FAILED',
      errors: [{ path, message }],
    });
    expect(uploadFailure(400, body('images.1', 'must be at most 8 MB'), names)).toBe(
      'back.jpg is larger than 8 MB.',
    );
    expect(uploadFailure(400, body('images.0', 'must be a JPEG, PNG or WebP image'), names)).toBe(
      "front.jpg isn't a JPEG, PNG or WebP.",
    );
    expect(uploadFailure(415, null, names)).toBe("A photo isn't a JPEG, PNG or WebP.");
    expect(uploadFailure(413, null, names)).toBe('A photo is larger than 8 MB.');
    expect(uploadFailure(429, null, names)).toBe(
      "You've started 10 listings in the last minute. Try again in a moment.",
    );
    expect(uploadFailure(0, null, names)).toBe(
      "Couldn't upload the photos. Check your connection and try again.",
    );
  });

  it('announces a choice once, refusals included, so a refused photo is never silent', () => {
    expect(choiceAnnouncement(2, 3, [])).toBe('2 photos added. 3 of 4 chosen.');
    expect(choiceAnnouncement(0, 0, ["photo.heic isn't a JPEG, PNG or WebP."])).toBe(
      "photo.heic isn't a JPEG, PNG or WebP.",
    );
    expect(choiceAnnouncement(1, 4, ["Choose up to 4 photos. e.jpg wasn't added."])).toBe(
      "1 photo added. 4 of 4 chosen. Choose up to 4 photos. e.jpg wasn't added.",
    );
    expect(choiceAnnouncement(0, 2, [])).toBeNull();
  });
});

describe('photo resolution', () => {
  it('advises on a photo under 1600 px on its long edge, by the edge it is', () => {
    expect(resolutionNote('photo.jpg', 588, 391)).toBe(
      'photo.jpg is 588 px wide. Product pages look best from 1600 px.',
    );
    expect(resolutionNote('tall.png', 900, 1200)).toBe(
      'tall.png is 1200 px tall. Product pages look best from 1600 px.',
    );
    expect(resolutionNote('big.jpg', 1600, 1067)).toBeNull();
  });
});

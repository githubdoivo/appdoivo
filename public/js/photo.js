// Client-side photo resize, shared between app.js (guest self-registration/
// change-photo) and settings.js (admin manually adding a contestant) - a
// phone camera photo can easily be 5-10MB at full resolution, and the
// request (base64, in a JSON body) needs to stay small. This is a courtesy,
// not the enforcement - the server has its own hard cap (see decodePhoto()
// in src/votes.js) since a client-side limit alone can't be trusted.
import { t } from './i18n.js';

const PHOTO_MAX_DIMENSION = 800;
const PHOTO_JPEG_QUALITY = 0.8;

export function resizePhotoToJpeg(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, PHOTO_MAX_DIMENSION / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', PHOTO_JPEG_QUALITY));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(t('err_photo_invalid'))); };
    img.src = url;
  });
}

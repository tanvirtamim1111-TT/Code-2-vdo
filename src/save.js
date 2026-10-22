// Saving and sharing the rendered video, in the browser and inside the Android app.
import { Capacitor } from '@capacitor/core';

export const isNative = () => Capacitor.isNativePlatform();

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

async function writeNative(blob, path, directory) {
  const { Filesystem } = await import('@capacitor/filesystem');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const CHUNK = 3 * 1024 * 1024; // multiple of 3 so base64 chunks concatenate cleanly
  for (let i = 0; i < bytes.length || i === 0; i += CHUNK) {
    const data = toBase64(bytes.subarray(i, i + CHUNK));
    if (i === 0) await Filesystem.writeFile({ path, data, directory, recursive: true });
    else await Filesystem.appendFile({ path, data, directory });
    if (bytes.length === 0) break;
  }
  const { uri } = await Filesystem.getUri({ path, directory });
  return uri;
}

let lastNativeUri = null;

// Returns a short human-readable description of where the file went.
export async function saveVideo(blob, name) {
  if (isNative()) {
    const { Directory } = await import('@capacitor/filesystem');
    try {
      lastNativeUri = await writeNative(blob, `Code2Video/${name}`, Directory.Documents);
      return `সেভ হয়েছে: Documents/Code2Video/${name}`;
    } catch (e) {
      lastNativeUri = await writeNative(blob, name, Directory.Cache);
      await shareVideo(blob, name);
      return 'শেয়ার মেনু থেকে গ্যালারি/ড্রাইভে সেভ করুন';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return `ডাউনলোড শুরু হয়েছে: ${name}`;
}

export function canShare(blob, name) {
  if (isNative()) return true;
  try {
    const file = new File([blob], name, { type: 'video/mp4' });
    return !!(navigator.canShare && navigator.canShare({ files: [file] }));
  } catch (e) {
    return false;
  }
}

export async function shareVideo(blob, name) {
  if (isNative()) {
    const { Share } = await import('@capacitor/share');
    if (!lastNativeUri) {
      const { Directory } = await import('@capacitor/filesystem');
      lastNativeUri = await writeNative(blob, name, Directory.Cache);
    }
    await Share.share({ title: name, files: [lastNativeUri] });
    return;
  }
  const file = new File([blob], name, { type: 'video/mp4' });
  await navigator.share({ files: [file], title: name });
}

export function resetShare() { lastNativeUri = null; }

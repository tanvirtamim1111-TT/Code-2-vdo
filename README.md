# Code2Video 🎬

Claude AI (বা অন্য কোনো AI) যে কোড দিয়ে মোশন/অ্যানিমেশন বানায়, সেই কোড পেস্ট করুন →
প্রিভিউ দেখুন → **Full HD (1920×1080) MP4 ভিডিও** রেন্ডার করে ডাউনলোড করুন।
সব কাজ আপনার ফোনেই হয়, কোনো সার্ভারে আপলোড হয় না।

## 📱 মোবাইলে ইনস্টল

### উপায় ১: APK (Android)
1. এই রিপোর [**Releases**](https://github.com/tanvirtamim1111-TT/Code-2-vdo/releases/latest) পেজে যান।
2. `Code2Video.apk` ডাউনলোড করুন।
3. ফাইলটি খুলুন → প্রথমবার “Install unknown apps / অজানা উৎস থেকে ইনস্টল” অনুমতি দিন → **Install**।

প্রতিবার কোড পুশ হলে GitHub Actions নিজে থেকে নতুন APK বানিয়ে Releases-এ দেয়।

### উপায় ২: ওয়েব অ্যাপ (Android / iPhone)
1. Chrome-এ খুলুন: `https://tanvirtamim1111-tt.github.io/Code-2-vdo/`
2. উপরের **⬇ ইনস্টল** বাটন, অথবা মেনু (⋮) → **Add to Home screen / Install app**।
3. একবার খোলার পর অফলাইনেও চলে।

> GitHub Pages প্রথমবার চালু না হলে: রিপো **Settings → Pages → Source: GitHub Actions** বেছে নিন।

## ✨ কী কী কোড চলে

| ধরন | উদাহরণ |
| --- | --- |
| **HTML / CSS / JS** | `@keyframes`, CSS transition, Web Animations, SVG, `<canvas>`, GSAP, anime.js, three.js |
| **React (JSX/TSX)** | Claude-এর React আর্টিফ্যাক্ট, Tailwind ক্লাস, `framer-motion` / `motion`, `lucide-react` |
| **Remotion** | `useCurrentFrame`, `interpolate`, `spring`, `Sequence`, `Series`, `AbsoluteFill`, `Composition` |
| **শুধু JavaScript** | canvas-এ আঁকার স্ক্রিপ্ট |

- ```` ```html ```` / ```` ```css ```` / ```` ```js ```` আলাদা ব্লক একসাথে পেস্ট করলেও জোড়া লাগিয়ে চালায়।
- React, framer-motion, GSAP, three.js, lucide-react, Tailwind অ্যাপের ভিতরেই আছে (ইন্টারনেট লাগে না)।
  অন্য কোনো npm প্যাকেজ import করলে সেটা ইন্টারনেট থেকে (esm.sh) আনে।
- Remotion কোডে `durationInFrames`, `fps`, সাইজ দেওয়া থাকলে সেটিংস নিজে থেকেই সেট হয়।

## ⚙️ সেটিংস
- সাইজ: 16:9 Full HD, 9:16 (Reels/Shorts), 1:1, 4:5, 720p, 4K
- FPS: 24 / 30 / 60
- সময়: সেকেন্ডে (CSS/GSAP অ্যানিমেশন থেকে “অটো” বের করা যায়)
- কোয়ালিটি: স্বাভাবিক / হাই / সর্বোচ্চ

## 🛠 কীভাবে কাজ করে
কোডটা একটা আলাদা iframe-এ চলে, যেখানে ঘড়ি (`performance.now`, `Date`, `requestAnimationFrame`,
`setTimeout`, CSS/WAAPI/SVG অ্যানিমেশন) অ্যাপের নিয়ন্ত্রণে থাকে। রেন্ডারের সময় প্রতিটা ফ্রেমে ঘড়ি
ঠিক `1/fps` সেকেন্ড এগিয়ে ছবি তোলা হয়, তাই ফোন ধীর হলেও ভিডিও ঝাঁকুনি ছাড়া মসৃণ হয়।
ছবিগুলো WebCodecs দিয়ে H.264 (বা ডিভাইস সাপোর্ট না করলে VP9) MP4-এ এনকোড হয়।

## 💻 ডেভেলপমেন্ট
```bash
npm install
npm run dev          # লোকাল সার্ভার
npm run build        # dist/ এ ওয়েব বিল্ড
npm run android:sync # Android প্রজেক্টে কপি (আগে একবার: npx cap add android)
```

## ⚠️ সীমাবদ্ধতা
- অডিও এখনো ভিডিওতে যোগ হয় না।
- রেন্ডারের সময় স্ক্রিন চালু রাখুন, অ্যাপ থেকে বের হলে রেন্ডার থেমে যেতে পারে।
- iPhone-এ Safari 16.4+ লাগবে; পুরোনো ব্রাউজারে ভিডিও এনকোডার নাও থাকতে পারে।

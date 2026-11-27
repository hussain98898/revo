// إعدادات الاتصال بمشروع Firebase الخاص بالمطعم.
// من لوحة Firebase: Project settings › General › Your apps › (تطبيق الويب) › SDK setup and configuration › Config
// انسخ القيم إلى الأسطر التالية ثم احفظ الملف باسم config.js في المجلد نفسه. الملف يُنشر مع التطبيق ولا يحتوي أسرارًا:
// الحماية الحقيقية في قواعد قاعدة البيانات (firestore.rules)، لا في هذه القيم.
window.REVO_CONFIG = {
  firebase: {
    apiKey: 'PASTE_API_KEY',
    authDomain: 'PASTE_PROJECT_ID.firebaseapp.com',
    projectId: 'PASTE_PROJECT_ID',
    storageBucket: 'PASTE_PROJECT_ID.firebasestorage.app',
    messagingSenderId: 'PASTE_SENDER_ID',
    appId: 'PASTE_APP_ID',
  },
  build: '202611270956',
};

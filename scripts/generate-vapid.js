// Generates a VAPID key pair for Web Push and prints the lines for .env
import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();
console.log('\nAdd this to your .env file:\n');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log('VAPID_SUBJECT=mailto:admin@example.com\n');

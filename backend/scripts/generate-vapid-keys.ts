/** Print a new VAPID key pair for Web Push. Store the private key only in the backend runtime environment. */
import webpush from 'web-push';
const keys = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\nVAPID_SUBJECT=mailto:you@example.com`);

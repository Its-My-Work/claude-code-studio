const bcrypt = require('bcryptjs');
const auth = require('./auth');

async function testLogin() {
  try {
    const token = await auth.login('2nn3b2nn3b');
    console.log('Login successful, token:', token);
  } catch (err) {
    console.log('Login failed:', err.message);
  }
}

testLogin();
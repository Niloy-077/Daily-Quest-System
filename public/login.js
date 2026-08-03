'use strict';

const form = document.getElementById('auth-form');
const messageBox = document.getElementById('message');
const submitBtn = document.getElementById('submit-btn');
const tabLogin = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');
const displayNameField = document.getElementById('display-name-field');
const passwordHint = document.getElementById('password-hint');
const passwordInput = document.getElementById('password');

let mode = 'login';

function showMessage(text, kind = 'error') {
    messageBox.textContent = text;
    messageBox.className = `message ${kind}`;
    messageBox.hidden = false;
}

function clearMessage() {
    messageBox.hidden = true;
}

function setMode(next) {
    mode = next;
    const registering = mode === 'register';

    tabLogin.classList.toggle('active', !registering);
    tabRegister.classList.toggle('active', registering);
    displayNameField.hidden = !registering;
    passwordHint.hidden = !registering;
    submitBtn.textContent = registering ? 'Awaken' : 'Enter the System';
    passwordInput.autocomplete = registering ? 'new-password' : 'current-password';
    clearMessage();
}

tabLogin.addEventListener('click', () => setMode('login'));
tabRegister.addEventListener('click', () => setMode('register'));

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearMessage();
    submitBtn.disabled = true;

    const body = {
        username: document.getElementById('username').value.trim(),
        password: passwordInput.value,
        // The server needs the player's own zone to work out when their day
        // ends, which is what quest deadlines default to.
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    };
    if (mode === 'register') {
        body.displayName = document.getElementById('display-name').value.trim() || body.username;
    }

    try {
        const response = await fetch(`/api/auth/${mode}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            showMessage(data.message || 'Authentication failed.');
            submitBtn.disabled = false;
            return;
        }

        window.location.href = '/';
    } catch (err) {
        showMessage('Cannot reach the System. Is the server running?');
        submitBtn.disabled = false;
    }
});

setMode('login');

// 1. Core System State (Loaded from Local Storage or Defaults)
let playerState = JSON.parse(localStorage.getItem('playerState')) || {
    level: 1,
    currentExp: 0,
    maxExp: 200,
    stats: { strength: 10, intelligence: 10, vitality: 10 }
};

let isPenalized = localStorage.getItem('isPenalized') === 'true';
let activePenalty = localStorage.getItem('activePenalty') || "";
let customQuests = JSON.parse(localStorage.getItem('customQuests')) || [];

// 2. The Penalty Quest Pool
const penaltyPool = [
    "Gather knowledge in one field and do 10 minutes of research on it.",
    "Perform 5 Push-ups.",
    "Clean your room.",
    "Practice gratefulness for 5 minutes",
    "Spend 10 minutes reading an article on food nutrition or natural health practices.",
    "Brainstorm a digital marketing concept for 5 minutes."
];

// Save current state to browser memory
function saveState() {
    localStorage.setItem('playerState', JSON.stringify(playerState));
    localStorage.setItem('isPenalized', isPenalized);
    localStorage.setItem('activePenalty', activePenalty);
    localStorage.setItem('customQuests', JSON.stringify(customQuests));
}

// 3. Custom Quest Logic
function addNewQuest() {
    const input = document.getElementById('new-quest-input');
    const questText = input.value.trim();
    
    if (questText === "") return; // Don't add empty quests

    customQuests.push({ id: Date.now(), text: questText });
    input.value = ""; // Clear input
    saveState();
    renderQuests();
}

function renderQuests() {
    const questList = document.getElementById('quest-list');
    questList.innerHTML = ""; // Clear current list

    if (customQuests.length === 0) {
        questList.innerHTML = "<p style='color: #888;'>No active quests. Add one above.</p>";
        return;
    }

    customQuests.forEach((quest, index) => {
        const questCard = document.createElement('div');
        questCard.className = 'quest-card';
        questCard.style.cssText = "padding: 15px; border: 1px solid #333; margin-bottom: 10px; border-radius: 4px; background: #1a1a20;";
        
        questCard.innerHTML = `
            <p style="margin-bottom: 10px;"><strong>Task:</strong> ${quest.text}</p>
            <button onclick="completeQuest(${index})">Complete Quest (+50 EXP)</button>
            <button class="fail-btn" onclick="triggerPenalty(${index})" style="border-color: #ef4444; color: #ef4444;">Fail Quest (Trigger Penalty)</button>
        `;
        questList.appendChild(questCard);
    });
}

// 4. Complete Quest & Gain EXP
function completeQuest(index) {
    if (isPenalized) {
        alert("SYSTEM ALERT: The System is locked. You must complete your penalty protocol first.");
        return; 
    }
    
    // Remove quest from list
    customQuests.splice(index, 1);
    
    playerState.currentExp += 50;
    
    if (playerState.currentExp >= playerState.maxExp) {
        triggerLevelUp();
    } else {
        saveState();
        updateUI();
        renderQuests();
    }
}

// 5. Level Up Logic
function triggerLevelUp() {
    playerState.level += 1;
    playerState.maxExp *= 2; 
    playerState.currentExp = 0; 
    
    playerState.stats.strength += 1;
    playerState.stats.intelligence += 2;
    playerState.stats.vitality += 1;
    
    saveState();
    updateUI();
    renderQuests();
    
    const overlay = document.getElementById('levelup-overlay');
    overlay.style.display = 'flex';
    setTimeout(() => overlay.style.display = 'none', 3500);
}

// 6. Penalty Lock (Inescapable)
function triggerPenalty(index) {
    // Remove the failed quest
    customQuests.splice(index, 1);
    
    isPenalized = true;
    activePenalty = penaltyPool[Math.floor(Math.random() * penaltyPool.length)];
    saveState();
    
    showPenaltyScreen();
    renderQuests();
}

function showPenaltyScreen() {
    if (!isPenalized) return;
    
    const overlay = document.getElementById('penalty-overlay');
    const taskDisplay = document.getElementById('random-penalty-task');
    taskDisplay.innerText = activePenalty;
    overlay.style.display = 'flex';
}

function completePenaltyQuest() {
    isPenalized = false;
    activePenalty = "";
    saveState();
    
    document.getElementById('penalty-overlay').style.display = 'none';
}

// 7. Interface Updater
function updateUI() {
    document.getElementById('player-level').innerText = playerState.level;
    document.getElementById('exp-text').innerText = `${playerState.currentExp} / ${playerState.maxExp}`;
    
    const fillPercentage = (playerState.currentExp / playerState.maxExp) * 100;
    document.getElementById('exp-bar-fill').style.width = `${fillPercentage}%`;
    
    document.getElementById('stat-str').innerText = playerState.stats.strength;
    document.getElementById('stat-int').innerText = playerState.stats.intelligence;
    document.getElementById('stat-vit').innerText = playerState.stats.vitality;
}

// Initialize on load
updateUI();
renderQuests();
showPenaltyScreen(); // Instantly checks if they are trying to escape a penalty on reload

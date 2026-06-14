const fs = require('fs');
const path = require('path');

const SAVES_DIR = '/tmp/kurofune-saves';
const RANKING_FILE = path.join(SAVES_DIR, 'ranking.json');

if (!fs.existsSync(SAVES_DIR)) {
  fs.mkdirSync(SAVES_DIR, { recursive: true });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    const { playerId, playerName, clickerScore, reincarnationCount, fragments } = JSON.parse(event.body);

    if (!playerId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing playerId' })
      };
    }

    let rankingData = { players: [] };
    if (fs.existsSync(RANKING_FILE)) {
      rankingData = JSON.parse(fs.readFileSync(RANKING_FILE, 'utf-8'));
    }

    const playerIndex = rankingData.players.findIndex(p => p.playerId === playerId);
    const playerData = {
      playerId,
      playerName: playerName || '名無しの船長',
      clickerScore: Math.floor(clickerScore || 0),
      reincarnationCount: reincarnationCount || 0,
      fragments: fragments || 0,
      updatedAt: Date.now()
    };

    if (playerIndex >= 0) {
      rankingData.players[playerIndex] = playerData;
    } else {
      rankingData.players.push(playerData);
    }

    fs.writeFileSync(RANKING_FILE, JSON.stringify(rankingData, null, 2));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        success: true, 
        message: 'Ranking updated'
      })
    };
  } catch (error) {
    console.error('Ranking update error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};

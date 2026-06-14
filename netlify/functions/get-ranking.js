const fs = require('fs');
const path = require('path');

const SAVES_DIR = '/tmp/kurofune-saves';
const RANKING_FILE = path.join(SAVES_DIR, 'ranking.json');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    let rankingData = { players: [] };

    if (fs.existsSync(RANKING_FILE)) {
      rankingData = JSON.parse(fs.readFileSync(RANKING_FILE, 'utf-8'));
    }

    const sorted = rankingData.players
      .sort((a, b) => b.clickerScore - a.clickerScore)
      .slice(0, 100);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        data: sorted,
        count: sorted.length,
        success: true
      })
    };
  } catch (error) {
    console.error('Ranking error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};

const fs = require('fs');
const path = require('path');

const SAVES_DIR = '/tmp/kurofune-saves';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  if (event.httpMethod !== 'DELETE') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    const data = JSON.parse(event.body);
    const { playerId } = data;

    if (!playerId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing playerId' })
      };
    }

    const filePath = path.join(SAVES_DIR, `${playerId}.json`);
    const rankingPath = path.join(SAVES_DIR, 'ranking.json');

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    if (fs.existsSync(rankingPath)) {
      const rankingData = JSON.parse(fs.readFileSync(rankingPath, 'utf-8'));
      rankingData.players = rankingData.players.filter(p => p.playerId !== playerId);
      fs.writeFileSync(rankingPath, JSON.stringify(rankingData, null, 2));
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        success: true, 
        message: 'Delete successful'
      })
    };
  } catch (error) {
    console.error('Delete error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};

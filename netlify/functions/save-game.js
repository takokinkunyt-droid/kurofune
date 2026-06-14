const fs = require('fs');
const path = require('path');

const SAVES_DIR = '/tmp/kurofune-saves';

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
    const data = JSON.parse(event.body);
    const { playerId, saveData } = data;

    if (!playerId || !saveData) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing playerId or saveData' })
      };
    }

    const filePath = path.join(SAVES_DIR, `${playerId}.json`);
    const dataToSave = {
      ...saveData,
      playerId,
      lastSaveTime: Date.now()
    };

    fs.writeFileSync(filePath, JSON.stringify(dataToSave, null, 2));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        success: true, 
        message: 'Save successful',
        timestamp: Date.now()
      })
    };
  } catch (error) {
    console.error('Save error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};

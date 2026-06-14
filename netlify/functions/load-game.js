const fs = require('fs');
const path = require('path');

const SAVES_DIR = '/tmp/kurofune-saves';

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
    const { playerId } = event.queryStringParameters || {};

    if (!playerId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing playerId' })
      };
    }

    const filePath = path.join(SAVES_DIR, `${playerId}.json`);

    if (!fs.existsSync(filePath)) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ data: null, message: 'No save found' })
      };
    }

    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const saveData = JSON.parse(fileContent);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ data: saveData, success: true })
    };
  } catch (error) {
    console.error('Load error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};

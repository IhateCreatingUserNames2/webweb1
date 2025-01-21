const express = require('express');
const bodyParser = require('body-parser');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

// Replace with your MiniMax API key from environment variables
const MINI_MAX_API_KEY = process.env.MINI_MAX_API_KEY;

// Serve static files like index.html
app.use(express.static(__dirname));

// Serve index.html at the root route
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.use(bodyParser.json());

app.post('/chat', async (req, res) => {
    const { message } = req.body;

    if (!message) {
        return res.status(400).json({ error: 'Message is required.' });
    }

    try {
        const apiResponse = await fetch('https://api.minimaxi.chat/v1/text/chatcompletion_v2', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${MINI_MAX_API_KEY}`,
            },
            body: JSON.stringify({
                model: 'MiniMax-Text-01',
                max_tokens: 256, // Adjust based on your needs
                temperature: 0.7, // Default randomness
                top_p: 0.95, // Default nucleus sampling
                messages: [
                    {
                        role: 'system',
                        name: 'MM Intelligent Assistant',
                        content: 'MM Intelligent Assistant is a large language model that is self-developed by MiniMax.',
                    },
                    {
                        role: 'user',
                        name: 'user',
                        content: message,
                    },
                ],
            }),
        });

        const data = await apiResponse.json();

        if (apiResponse.ok && data.choices && data.choices[0]) {
            res.json({ reply: data.choices[0].message.content });
        } else {
            console.error('Error from MiniMax API:', data);
            res.status(500).json({
                error: 'MiniMax API responded with an error.',
                details: data,
            });
        }
    } catch (error) {
        console.error('Error connecting to MiniMax API:', error);
        res.status(500).json({ error: 'An error occurred while connecting to the MiniMax API.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

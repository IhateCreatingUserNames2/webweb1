const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Replace with your MiniMax API key
const MINI_MAX_API_KEY = process.env.MINI_MAX_API_KEY;

// Serve static files from the current directory
app.use(express.static(__dirname));

// Serve `index.html` on the root route
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.use(bodyParser.json());

app.post('/chat', async (req, res) => {
    const { message } = req.body;

    if (!message) {
        return res.status(400).send({ error: 'Message is required.' });
    }

    try {
        const response = await fetch('https://api.minimaxi.chat/v1/text/chatcompletion_v2', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${MINI_MAX_API_KEY}`,
            },
            body: JSON.stringify({
                model: 'MiniMax-Text-01',
                messages: [
                    {
                        role: 'system',
                        name: 'MM Intelligent Assistant',
                        content: 'MM Intelligent Assistant is a large language model that is self-developed by MiniMax and does not call the interface of other products.',
                    },
                    {
                        role: 'user',
                        name: 'user',
                        content: message,
                    },
                ],
            }),
        });

        const data = await response.json();

        if (data.choices && data.choices[0]) {
            res.send({ reply: data.choices[0].message.content });
        } else {
            res.status(500).send({ error: 'Invalid response from MiniMax API.' });
        }
    } catch (error) {
        console.error('Error:', error);
        res.status(500).send({ error: 'An error occurred while connecting to the MiniMax API.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

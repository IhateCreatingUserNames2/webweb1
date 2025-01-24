// Importando as dependências
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = 3000;

// Middleware para analisar o corpo das requisições
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Servir arquivos estáticos (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, 'public')));

// Rota para a página inicial
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Rota para receber os dados do formulário
app.post('/submit', (req, res) => {
  const {
    possuiEnergia,
    tipoFixacao,
    possuiModulos,
    equipamentos,
    potenciaMedia,
    horasDia,
    horasNoite,
    faturaEnergia,
    regiao,
    tempoSemEnergia
  } = req.body;

  // Processar os dados recebidos (ex.: enviar para uma LLM)
  console.log('Dados recebidos:', req.body);

  // Simulação de resposta da LLM
  const respostaLLM = {
    mensagem: "Dados processados com sucesso.",
    status: "success",
  };

  // Retorna a resposta
  res.json(respostaLLM);
});

// Iniciar o servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});

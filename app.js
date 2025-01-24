// Importando as dependências
const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');

const app = express();
const PORT = 3000;

// Configuração para upload de arquivos
const upload = multer({ dest: 'uploads/' });

// Middleware para analisar o corpo das requisições
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Rota para a página inicial
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Rota para receber os dados do formulário e upload de arquivos
app.post('/submit', upload.single('faturaEnergia'), (req, res) => {
  const {
    possuiEnergia,
    tipoFixacao,
    possuiModulos,
    equipamentos,
    potenciaMedia,
    horasDia,
    horasNoite,
    regiao,
    tempoSemEnergia
  } = req.body;

  const faturaEnergia = req.file;

  // Processar os dados recebidos (ex.: enviar para uma LLM)
  console.log('Dados recebidos:', req.body);
  if (faturaEnergia) {
    console.log('Arquivo de fatura recebido:', faturaEnergia);
  }

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

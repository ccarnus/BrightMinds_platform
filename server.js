const http = require('http');
const fs = require('fs');
const app = require('./app');

// HTTPS configuration
const PORT = process.env.PORT || 3000;
const httpServer = http.createServer(app);

httpServer.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
const express  = require('express');
const next     = require('next');
const path     = require('path');
const url      = require('url');
const cluster  = require('cluster');
const numCPUs  = require('os').cpus().length;
const redis    = require('redis');

require('dotenv').config()
const dev = process.env.NODE_ENV !== 'production';
const port = process.env.PORT || 3000;

// Multi-process to utilize all CPU cores.
if (!dev && cluster.isMaster) {
  console.log(`Node cluster master ${process.pid} is running`);

  // Fork workers.
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.error(`Node cluster worker ${worker.process.pid} exited: code ${code}, signal ${signal}`);
  });

} else {
  const nextApp = next({ dir: '.', dev });
  const nextHandler = nextApp.getRequestHandler();

  console.log('-----> Initializing server');

  nextApp.prepare()
    .then(() => {
      const server = express();      

      // Setup Redis datastore to receive messages from Redis "salesforce" channel
      const REDIS_URL = process.env.REDIS_URL;
      if (REDIS_URL == null) {
        throw new Error('Requires REDIS_URL env var.');
      }
      const redisStream = redis.createClient(REDIS_URL);
      redisStream.on("error", function (err) {
        console.error(`redis stream error: ${err.stack}`);
        process.exit(1);
      });
      redisStream.subscribe('salesforce');

      const redisQuery = redis.createClient(REDIS_URL);
      redisQuery.on("error", function (err) {
        console.error(`redis query error: ${err.stack}`);
        process.exit(1);
      });

      if (!dev) {
        // Enforce SSL & HSTS in production
        server.use(function(req, res, next) {
          var proto = req.headers["x-forwarded-proto"];
          if (proto === "https") {
            res.set({
              'Strict-Transport-Security': 'max-age=31557600' // one-year
            });
            return next();
          }
          res.redirect("https://" + req.headers.host + req.url);
        });
      }
      
      // Static files
      // https://github.com/zeit/next.js/tree/4.2.3#user-content-static-file-serving-eg-images
      server.use('/static', express.static(path.join(__dirname, 'static'), {
        maxAge: dev ? '0' : '365d'
      }));
    
      // Server-Sent Events handler to push messages to browser clients
      server.get('/stream/messages', (req, res, next) => {
        req.socket.setTimeout(0);
        let messageCount = 0;

        res.writeHead(200, {
          'Cache-Control': 'no-cache',
          'Content-Type': 'text/event-stream',
          'Connection': 'keep-alive'
        });
        res.write('\n');

        redisQuery.lrange('salesforce-recent', 0, -1, (err, response) => {
          if (err) throw err;
          response.reverse();
          response.forEach( message => {
            messageCount++;
            res.write(`event: salesforce\n`);
            res.write(`id: ${messageCount}\n`);
            res.write(`data: ${message}\n`);
            res.write('\n');
          })
        });

        redisStream.on("message", function (channel, message) {
          messageCount++;

          res.write(`event: ${channel}\n`);
          res.write(`id: ${messageCount}\n`);
          res.write(`data: ${message}\n`);
          res.write('\n');
        });
      })

      // Default catch-all renders Next app
      server.get('*', (req, res) => {
        // res.set({
        //   'Cache-Control': 'public, max-age=3600'
        // });
        const parsedUrl = url.parse(req.url, true);
        nextHandler(req, res, parsedUrl);
      });

      server.listen(port, (err) => {
        if (err) throw err;
        console.log(`Listening on http://localhost:${port}`);
      });
    })
    .catch( err => {
      console.error(err);
      process.exit(1);
    });
}

const pmx = require('pmx').init({
  http: true, // HTTP routes logging (default: false)
  ignore_routes: [/socket\.io/, /notFound/], // Ignore http routes with this pattern (default: [])
  errors: true, // Exceptions loggin (default: true)
  custom_probes: true, // Auto expose JS Loop Latency and HTTP req/s as probes (default: true)
  network: true, // Network monitoring at the application level (default: false)
  ports: true  // Shows which ports your app is listening on (default: false)
});

const express = require('express');
const https = require('https');
const WebSocket = require('ws');
const pm2 = require('pm2');
const fs = require('fs');
const path = require('path');

const app = express();

// Load SSL certificates
const privateKey = fs.readFileSync(path.join(__dirname, 'server.key'), 'utf8');
const certificate = fs.readFileSync(path.join(__dirname, 'server.cert'), 'utf8');

const credentials = { key: privateKey, cert: certificate };

const server = https.createServer(credentials, app);
const wss = new WebSocket.Server({ server });

let clients = [];

wss.on('connection', (ws) => {
  console.log('Client connected');
  clients.push(ws);

  ws.on('message', (message) => {
    const { type, id } = JSON.parse(message);
    if (type === 'restart') {
      pm2.restart(id, (err) => {
        if (err) {
          console.error(`Error restarting ${id}:`, err);
        } else {
          console.log(`${id} restarted successfully`);
          sendUpdates(); // Update all clients
        }
      });
    } else if (type === 'stop') {
      pm2.stop(id, (err) => {
        if (err) {
          console.error(`Error stopping ${id}:`, err);
        } else {
          console.log(`${id} stopped successfully`);
          sendUpdates(); // Update all clients
        }
      });
    } else if (type === 'start') {
      pm2.start(id, (err) => {
        if (err) {
          console.error(`Error starting ${id}:`, err);
        } else {
          console.log(`${id} started successfully`);
          sendUpdates(); // Update all clients
        }
      });
    } else if (type === 'clear') {
      clearLogs(id);
    } else if (type === 'start-all') {
      startAllProcesses();
    } else if (type === 'stop-all') {
      stopAllProcesses();
    } else if (type === 'restart-all') {
      restartAllProcesses();
    }
  });

  ws.on('close', () => {
    clients = clients.filter(client => client !== ws);
    console.log('Client disconnected');
  });
});

const clearLogs = (id) => {
  pm2.describe(id, (err, desc) => {
    if (err) {
      console.error(`Error describing ${id}:`, err);
      return;
    }

    const logPaths = desc[0].pm2_env;
    const logFiles = [logPaths.pm_out_log_path, logPaths.pm_err_log_path];

    logFiles.forEach((logFile) => {
      fs.truncate(logFile, 0, (err) => {
        if (err) {
          console.error(`Error clearing log file ${logFile}:`, err);
        } else {
          console.log(`Cleared log file ${logFile}`);
        }
      });
    });

    sendUpdates(); // Update all clients
  });
};

const sendUpdates = () => {
  pm2.list((err, list) => {
    if (err) {
      console.error('Error retrieving PM2 status', err);
      return;
    }
    const filteredList = list.filter(proc => !proc.pm2_env.pmx_module);
    const dataPromises = filteredList.map((proc) => {
      return new Promise((resolve, reject) => {
        const logFilePath = proc.pm2_env.pm_out_log_path;
        fs.readFile(logFilePath, 'utf8', (err, data) => {
          if (err) {
            return reject('Error reading log file');
          }

          const instanceId = proc.pm2_env.NODE_APP_INSTANCE;
          const isCluster = proc.pm2_env.exec_mode === 'cluster_mode' || proc.pm2_env.exec_mode === 'cluster';
          const appName = isCluster && instanceId !== undefined ? `${proc.name}-${instanceId}` : proc.name;

          resolve({
            id: proc.pm_id, // Use pm_id as a unique identifier
            name: appName,
            status: proc.pm2_env.status,
            restart: proc.pm2_env.restart_time,
            uptime: proc.pm2_env.pm_uptime,
            cpu: proc.monit.cpu,
            memory: (proc.monit.memory / 1024 / 1024).toFixed(2) + ' MB', // Convert memory to MB
            type: proc.pm2_env.exec_mode,
            logs: data.split('\n').slice(-100).join('\n') // Show up to 100 logs
          });
        });
      });
    });

    Promise.all(dataPromises)
      .then((processData) => {
        clients.forEach((client) => {
          client.send(JSON.stringify({ type: 'update', data: processData }));
        });
      })
      .catch((err) => {
        console.error(err);
      });
  });
};

const sendStateUpdates = () => {
  pm2.list((err, list) => {
    if (err) {
      console.error('Error retrieving PM2 status', err);
      return;
    }
    const filteredList = list.filter(proc => !proc.pm2_env.pmx_module);
    const processData = filteredList.map((proc) => {
      const instanceId = proc.pm2_env.NODE_APP_INSTANCE;
      const isCluster = proc.pm2_env.exec_mode === 'cluster_mode' || proc.pm2_env.exec_mode === 'cluster';
      const appName = isCluster && instanceId !== undefined ? `${proc.name}-${instanceId}` : proc.name;

      return {
        id: proc.pm_id, // Use pm_id as a unique identifier
        name: appName,
        status: proc.pm2_env.status,
        restart: proc.pm2_env.restart_time,
        cpu: proc.monit.cpu,
        memory: (proc.monit.memory / 1024 / 1024).toFixed(2) + ' MB', // Convert memory to MB
        type: proc.pm2_env.exec_mode
      };
    });

    clients.forEach((client) => {
      client.send(JSON.stringify({ type: 'statepm2', data: processData }));
    });
  });
};

const startAllProcesses = () => {
  pm2.list((err, list) => {
    if (err) {
      console.error('Error retrieving PM2 list', err);
      return;
    }
    const filteredList = list.filter(proc => !proc.pm2_env.pmx_module);
    filteredList.forEach((proc) => {
      pm2.start(proc.pm_id, (err) => {
        if (err) {
          console.error(`Error starting ${proc.pm_id}:`, err);
        } else {
          console.log(`${proc.pm_id} started successfully`);
        }
      });
    });
    sendUpdates(); // Update all clients
  });
};

const stopAllProcesses = () => {
  pm2.list((err, list) => {
    if (err) {
      console.error('Error retrieving PM2 list', err);
      return;
    }
    const filteredList = list.filter(proc => !proc.pm2_env.pmx_module);
    filteredList.forEach((proc) => {
      pm2.stop(proc.pm_id, (err) => {
        if (err) {
          console.error(`Error stopping ${proc.pm_id}:`, err);
        } else {
          console.log(`${proc.pm_id} stopped successfully`);
        }
      });
    });
    sendUpdates(); // Update all clients
  });
};

const restartAllProcesses = () => {
  pm2.list((err, list) => {
    if (err) {
      console.error('Error retrieving PM2 list', err);
      return;
    }
    const filteredList = list.filter(proc => !proc.pm2_env.pmx_module);
    filteredList.forEach((proc) => {
      pm2.restart(proc.pm_id, (err) => {
        if (err) {
          console.error(`Error restarting ${proc.pm_id}:`, err);
        } else {
          console.log(`${proc.pm_id} restarted successfully`);
        }
      });
    });
    sendUpdates(); // Update all clients
  });
};

// Send updates every 5 seconds
setInterval(sendUpdates, 1500);
setInterval(sendStateUpdates, 1500);

pm2.connect((err) => {
  if (err) {
    console.error('Error connecting to PM2', err);
    process.exit(2);
  }

  server.listen(1999, () => {
    console.log('Server is listening on port 1999');
  });
});

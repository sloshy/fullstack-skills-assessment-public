import app from './app';
import { config } from './config';
import { installProcessGuards } from './processGuards';

const server = app.listen(config.port, () => {
  console.log(`Terminal BFF listening on port ${config.port}`);
  console.log(`Payments API: ${config.paymentsApiUrl}`);
  console.log(`Surcharge service: ${config.surchargeServiceUrl}`);
});

// SIGTERM/SIGINT (graceful, with a forced exit), uncaughtException and unhandledRejection
installProcessGuards(server);

# OpenHVX Backend (Still in dev progress)

OpenHVX is an open-source IaaS platform for **Hyper-V**, built around an API-first architecture, lightweight services, and full multi-tenant isolation.

This repository contains the backend stack — API Gateway, Controller, Auth Service, and WebSocket Broker — designed to run with Traefik, MongoDB, and RabbitMQ.


> **⚠️ Project status:**  
> OpenHVX is currently in active development and **not ready for production**.  
> Features, APIs and configuration files may change without notice until the first stable release.

---

## 🐳 Quick start (with Docker Compose)

### 1. Requirements
- Podman or Docker (tested on Podman v5+, Docker 24+)
- `docker-compose` plugin or `podman-compose`
- Traefik configured to trust local certificates (mkcert recommended)

### 2. Clone the repository
```bash
git clone https://github.com/OpenHVX/openhvx-backend.git
cd openhvx-backend
```

### 3. Environment
Each service has its own `.env` file:

| Service | File | Description |
|----------|------|-------------|
| Auth Service | `.env.auth` | JWT and Mongo configuration |
| API Gateway | `.env.gateway` | HTTP gateway + CORS |
| Controller | `.env.controller` | Core logic, RabbitMQ, MongoDB |
| WS Broker | `.env.ws` | WebSocket broker configuration |

---

### 🧩 Example configuration

#### **WS Broker**
| Variable | Example | Description |
|-----------|----------|-------------|
| `PORT` | `8081` | HTTP port exposed by the broker |
| `JWT_AGENT_SECRET` | `supersecret_agent` | Token for agent auth |
| `JWT_BROWSER_SECRET` | `supersecret_browser` | Token for browser sessions |

---

#### **API Gateway**
| Variable | Example | Description |
|-----------|----------|-------------|
| `PORT` | `8080` | API Gateway port |
| `AUTH_URL` | `http://auth:4000` | Internal service URL for Auth |
| `CONTROLLER_URL` | `http://controller:3000` | Internal service URL for Controller |
| `CORS_ORIGIN` | `http://localhost:5173,http://127.0.0.1:5173` | Allowed origins for web UI |
| `BROKER_URL` | `http://ws-broker:8081` | Internal URL to WebSocket broker |

---

#### **Controller**
| Variable | Example | Description |
|-----------|----------|-------------|
| `PORT` | `3000` | HTTP port for Controller |
| `CORS_ORIGIN` | `*` | Allowed origins |
| `LOG_LEVEL` | `info` | Logging verbosity |
| `MONGO_URL` | `mongodb://mongo:27017/hvwm` | Mongo connection string |
| `MONGO_DB` | `openhvx` | Database name |
| `RMQ_URL` | `amqp://guest:guest@rabbitmq:5672/` | RabbitMQ connection |
| `JOBS_EXCHANGE` | `jobs` | Exchange for async jobs |
| `TELEMETRY_EXCHANGE` | `agent.telemetry` | Exchange for telemetry |
| `RESULTS_EXCHANGE` | `results` | Exchange for agent task results |
| `HEARTBEATS_QUEUE` | `agent.heartbeats` | Queue for agent heartbeats |
| `HEARTBEATS_TTL_MS` | `120000` | Heartbeat timeout (ms) |
| `INVENTORIES_QUEUE` | `agent.inventories` | Queue for agent inventories |
| `RESULTS_QUEUE` | `results.controller` | Queue consumed by controller |
| `RESULTS_BINDING` | `results.*` | Routing key pattern |
| `AGENT_STALE_MS` | `120000` | Delay to mark agent as offline |
| `IMAGES_INDEX_PATH` | `/share/_index/images.json` | Path to shared image index |
| `JWT_AGENT_SECRET` | `supersecret_agent` | JWT secret for agents |
| `JWT_BROWSER_SECRET` | `supersecret_browser` | JWT secret for browsers |
| `PUBLIC_WS_BASE` | `wss://console.openhvx.local/api` | Browser WebSocket endpoint |
| `BROKER_WS_BASE` | `wss://ws.openhvx.local` | Direct agent WebSocket endpoint |

---

#### **Auth Service**
| Variable | Example | Description |
|-----------|----------|-------------|
| `PORT` | `4000` | HTTP port |
| `MONGO_URL` | `mongodb://mongo:27017/hvwm_auth` | Auth DB connection |
| `JWT_SECRET` | `change-me` | Main signing secret |
| `JWT_EXPIRES` | `8h` | Default token lifetime |
| `AUTH_DEBUG` | `true` | Enable verbose logs |
| `JWT_TENANT_ISS` | `auth-service/tenant` | JWT issuer (tenant) |
| `JWT_TENANT_AUD` | `api://tenant` | JWT audience (tenant) |
| `JWT_TENANT_SECRET` | `example_secret` | Tenant token secret |
| `JWT_TENANT_EXPIRES` | `8h` | Tenant token lifetime |
| `JWT_ADMIN_ISS` | `auth-service/admin` | JWT issuer (admin) |
| `JWT_ADMIN_AUD` | `api://admin` | JWT audience (admin) |
| `JWT_ADMIN_SECRET` | `example_secret` | Admin token secret |
| `JWT_ADMIN_EXPIRES` | `30m` | Admin token lifetime |
| `REGISTER_ENABLED` | `true` | Allow new user registration |
| `REGISTER_API_KEY` | `example_api_key` | Optional registration key |

---

### 4. Start the full stack
```bash
docker compose up -d
```
or:
```bash
podman-compose up -d
```

To stop everything:
```bash
docker compose down
```

---

## 📘 Documentation

Full documentation and architecture guides are available at:

👉 **https://openhvx.org/docs**

---

## 🗂️ Legacy version

The previous generation of the backend has been archived under:  
**archive/legacy-main**  
https://github.com/OpenHVX/openhvx-backend/tree/archive/legacy-main

---

## ⚖️ License

Apache-2.0  
© 2025 OpenHVX

**RFC-001**

**Financial Ledger API**

Bun + Elysia + TypeScript

_Append-only, auditavel, consistente e deterministico_

| **Campo** | **Valor**                                          |
| --------- | -------------------------------------------------- |
| Status    | DRAFT                                              |
| Autor     | Staff Engineer                                     |
| Data      | 2026-03-17                                         |
| Stack     | Bun 1.x, Elysia 1.x, TypeScript 5.x, PostgreSQL 16 |
| Revisores | Tech Lead, Arquitetura, Produto                    |

# **1\. Arquitetura**

## **1.1 Visao Geral**

O sistema e um ledger financeiro append-only construido sobre Bun + Elysia + PostgreSQL. A arquitetura segue o principio de que o ledger e a fonte de verdade e saldos sao sempre derivados, nunca armazenados como dado primario.

### **1.1.1 Stack e Justificativas**

| **Componente** | **Tecnologia**     | **Justificativa**                                                        |
| -------------- | ------------------ | ------------------------------------------------------------------------ |
| Runtime        | Bun 1.x            | Performance nativa, hot reload, compatibilidade Node.js                  |
| Framework HTTP | Elysia 1.x         | Type-safe por design, validacao via TypeBox, performance superior no Bun |
| Banco de dados | PostgreSQL 16      | ACID, suporte a advisory locks, window functions, particoes nativas      |
| Linguagem      | TypeScript 5.x     | Type safety em compile-time, branded types para dominio financeiro       |
| Migracao       | Drizzle ORM        | Type-safe, zero overhead, migracao declarativa                           |
| Cron           | Bun.cron / pg_cron | pg_cron para producao (nao depende do processo da aplicacao)             |

### **1.1.2 Principios Arquiteturais**

- **Append-only:** Nenhuma operacao de UPDATE ou DELETE nas tabelas de transacao. Garantido por triggers no banco.
- **Saldo derivado:** Saldo nunca e coluna persistida como fonte de verdade. Sempre calculado: checkpoint + SUM(transacoes posteriores).
- **Determinismo:** Dado o mesmo estado do ledger, qualquer calculo de saldo produz o mesmo resultado. Sem side-effects.
- **Auditabilidade:** Todo registro inclui created_at, idempotency_key, request_id. Nada e apagado.
- **Inteiros:** Todos os valores monetarios em centavos (int64). Zero uso de float/decimal em runtime.

### **1.1.3 Diagrama de Camadas**

┌─────────────────────────────────────────────────────────┐

│ API Layer (Elysia) │

│ Routes -> Validation (TypeBox) -> Error Handling │

├─────────────────────────────────────────────────────────┤

│ Service Layer │

│ TransactionService | BalanceService | CheckpointService │

├─────────────────────────────────────────────────────────┤

│ Repository Layer │

│ TransactionRepo | CheckpointRepo | AccountRepo │

├─────────────────────────────────────────────────────────┤

│ PostgreSQL (ACID, Append-Only) │

│ Triggers | Advisory Locks | Partitions | Indexes │

└─────────────────────────────────────────────────────────┘

## **1.2 Trade-offs Arquiteturais**

| **Decisao**                                 | **Vantagem**                                  | **Desvantagem**                          | **Alternativa Descartada**              |
| ------------------------------------------- | --------------------------------------------- | ---------------------------------------- | --------------------------------------- |
| PostgreSQL unico (sem event store dedicado) | Simplicidade operacional, ACID nativo         | Throughput limitado vs Kafka             | EventStoreDB (complexidade operacional) |
| Checkpoint diario                           | Leitura O(1) para saldo do dia anterior       | Janela de inconsistencia durante geracao | Materialized views (lock contention)    |
| Advisory locks vs SELECT FOR UPDATE         | Nao bloqueia reads, granularidade por account | Requer tratamento explicito no codigo    | Serializable isolation (deadlocks)      |
| Drizzle vs Prisma                           | Zero overhead, SQL transparente               | Ecossistema menor                        | Prisma (overhead, query engine)         |

# **2\. Modelagem de Dominio**

## **2.1 Tipos de Dominio (Branded Types)**

Usamos branded types para evitar confusao entre IDs e valores monetarios em compile-time. Isso impede que um account_id seja passado onde se espera um transaction_id.

// src/domain/types.ts

type Brand&lt;T, B&gt; = T & { \_\_brand: B };

export type AccountId = Brand&lt;string, 'AccountId'&gt;;

export type TxId = Brand&lt;string, 'TransactionId'&gt;;

export type Cents = Brand&lt;number, 'Cents'&gt;; // int, NUNCA float

export type IdempotencyKey = Brand&lt;string, 'IdempotencyKey'&gt;;

// Factory functions com validacao

export function cents(value: number): Cents {

if (!Number.isInteger(value)) {

throw new DomainError('INVALID_AMOUNT', 'Valor deve ser inteiro (centavos)');

}

if (value &lt; -999_999_999_99 || value &gt; 999_999_999_99) {

throw new DomainError('AMOUNT_OVERFLOW', 'Valor excede limites');

}

return value as Cents;

}

export function accountId(value: string): AccountId {

if (!/^acc\_\[a-zA-Z0-9\]{20}\$/.test(value)) {

throw new DomainError('INVALID_ACCOUNT_ID', 'Formato invalido');

}

return value as AccountId;

}

## **2.2 Entidades do Dominio**

### **2.2.1 Account**

// src/domain/entities/account.ts

export interface Account {

readonly id: AccountId;

readonly external_id: string; // ID do sistema externo

readonly currency: 'BRL' | 'USD';

readonly status: 'ACTIVE' | 'FROZEN' | 'CLOSED';

readonly created_at: Date;

readonly metadata: Record&lt;string, unknown&gt;;

}

### **2.2.2 Transaction (Entrada do Ledger)**

// src/domain/entities/transaction.ts

export type TransactionType = 'CREDIT' | 'DEBIT';

export interface Transaction {

readonly id: TxId;

readonly account_id: AccountId;

readonly type: TransactionType;

readonly amount: Cents; // Sempre positivo

readonly description: string;

readonly idempotency_key: IdempotencyKey;

readonly request_id: string; // trace ID

readonly created_at: Date; // imutavel

readonly metadata: Record&lt;string, unknown&gt;;

}

// REGRA: amount e sempre positivo.

// O campo type define a direcao: CREDIT soma, DEBIT subtrai.

### **2.2.3 Checkpoint**

// src/domain/entities/checkpoint.ts

export interface Checkpoint {

readonly id: string;

readonly account_id: AccountId;

readonly balance: Cents; // Saldo consolidado ate reference_date

readonly reference_date: string; // ISO date YYYY-MM-DD

readonly last_transaction_id: TxId; // Ultima tx incluida

readonly transaction_count: number; // Qtd de txs acumuladas

readonly created_at: Date;

readonly checksum: string; // SHA-256 para verificacao

}

## **2.3 Invariantes do Dominio**

**IMPORTANTE:** Estas invariantes DEVEM ser garantidas em todas as camadas: dominio, servico e banco.

- Transaction.amount > 0 (sempre positivo, tipo define direcao)
- Transaction.amount e inteiro (centavos, nunca float)
- Nenhum UPDATE/DELETE em transactions (trigger no banco impede)
- Checkpoint.balance == SUM de todas as transacoes ate reference_date
- Checkpoint e unico por (account_id, reference_date) via UNIQUE constraint
- Saldo atual = checkpoint.balance + SUM(txs apos checkpoint)
- Account com status FROZEN ou CLOSED nao aceita novas transacoes

# **3\. Modelagem de Banco (SQL)**

## **3.1 Tabela: accounts**

CREATE TABLE accounts (

id TEXT PRIMARY KEY, -- acc_xxxxxxxxxxxxxxxxxxxx

external_id TEXT NOT NULL UNIQUE,

currency TEXT NOT NULL DEFAULT 'BRL'

CHECK (currency IN ('BRL', 'USD')),

status TEXT NOT NULL DEFAULT 'ACTIVE'

CHECK (status IN ('ACTIVE', 'FROZEN', 'CLOSED')),

created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

metadata JSONB NOT NULL DEFAULT '{}'::jsonb

);

CREATE INDEX idx_accounts_external_id ON accounts(external_id);

CREATE INDEX idx_accounts_status ON accounts(status);

## **3.2 Tabela: transactions (Particionada)**

CREATE TABLE transactions (

id TEXT NOT NULL, -- tx_xxxxxxxxxxxxxxxxxxxx

account_id TEXT NOT NULL REFERENCES accounts(id),

type TEXT NOT NULL CHECK (type IN ('CREDIT', 'DEBIT')),

amount BIGINT NOT NULL CHECK (amount > 0), -- centavos, sempre positivo

description TEXT NOT NULL DEFAULT '',

idempotency_key TEXT NOT NULL,

request_id TEXT NOT NULL DEFAULT '',

created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

PRIMARY KEY (id, created_at) -- incluir partition key na PK

) PARTITION BY RANGE (created_at);

\-- Particao mensal (criar via cron ou migration)

CREATE TABLE transactions_2026_03 PARTITION OF transactions

FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');

CREATE TABLE transactions_2026_04 PARTITION OF transactions

FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

\-- Indices criticos

CREATE UNIQUE INDEX idx_tx_idempotency

ON transactions(idempotency_key);

CREATE INDEX idx_tx_account_created

ON transactions(account_id, created_at DESC);

CREATE INDEX idx_tx_account_id_created_covering

ON transactions(account_id, created_at DESC)

INCLUDE (type, amount); -- covering index para calculo de saldo

### **3.2.1 Justificativa do Particionamento**

A tabela transactions e particionada por mes usando RANGE partitioning no campo created_at. Isso garante:

- **Performance:** Queries de saldo que filtram por data fazem partition pruning automatico, lendo apenas particoes relevantes.
- **Manutencao:** Particoes antigas podem ser detached e movidas para cold storage sem afetar operacoes correntes.
- **Vacuuming:** VACUUM e ANALYZE operam em particoes menores, reduzindo lock contention.

## **3.3 Tabela: checkpoints**

CREATE TABLE checkpoints (

id TEXT PRIMARY KEY,

account_id TEXT NOT NULL REFERENCES accounts(id),

balance BIGINT NOT NULL, -- saldo consolidado em centavos

reference_date DATE NOT NULL,

last_transaction_id TEXT NOT NULL,

transaction_count INTEGER NOT NULL DEFAULT 0,

checksum TEXT NOT NULL, -- SHA-256(account_id|balance|ref_date|last_tx_id)

created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

CONSTRAINT uq_checkpoint_account_date

UNIQUE (account_id, reference_date)

);

CREATE INDEX idx_checkpoint_account_date

ON checkpoints(account_id, reference_date DESC);

## **3.4 Tabela: checkpoint_executions (Idempotencia do Cron)**

CREATE TABLE checkpoint_executions (

id TEXT PRIMARY KEY,

reference_date DATE NOT NULL UNIQUE, -- Uma execucao por dia

status TEXT NOT NULL DEFAULT 'RUNNING'

CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),

started_at TIMESTAMPTZ NOT NULL DEFAULT now(),

completed_at TIMESTAMPTZ,

accounts_total INTEGER NOT NULL DEFAULT 0,

accounts_done INTEGER NOT NULL DEFAULT 0,

error_message TEXT,

CONSTRAINT uq_execution_date UNIQUE (reference_date)

);

## **3.5 Trigger: Imutabilidade do Ledger**

\-- Impede UPDATE e DELETE na tabela de transacoes

CREATE OR REPLACE FUNCTION prevent_mutation()

RETURNS TRIGGER AS \$\$

BEGIN

RAISE EXCEPTION

'LEDGER_IMMUTABLE: operacao % proibida na tabela transactions',

TG_OP;

RETURN NULL;

END;

\$\$ LANGUAGE plpgsql;

CREATE TRIGGER trg_no_update_transactions

BEFORE UPDATE ON transactions

FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER trg_no_delete_transactions

BEFORE DELETE ON transactions

FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

**NOTA:** Esses triggers garantem imutabilidade no nivel do banco, independente de bugs no codigo da aplicacao. E a ultima linha de defesa.

# **4\. Fluxo de Calculo de Saldo**

## **4.1 Formula**

O saldo e SEMPRE derivado, nunca lido de uma coluna persistida como fonte de verdade:

saldo_atual = checkpoint.balance

\+ SUM(CREDIT.amount WHERE created_at > checkpoint.reference_date)

\- SUM(DEBIT.amount WHERE created_at > checkpoint.reference_date)

Se nao existe checkpoint para a conta, o calculo parte do zero e soma todas as transacoes.

## **4.2 Implementacao**

// src/services/balance.service.ts

export class BalanceService {

constructor(

private readonly db: Database,

private readonly checkpointRepo: CheckpointRepository,

private readonly txRepo: TransactionRepository,

) {}

async getBalance(accountId: AccountId): Promise<{

balance: Cents;

checkpoint_date: string | null;

transactions_after_checkpoint: number;

calculated_at: Date;

}> {

// 1. Buscar checkpoint mais recente

const checkpoint = await this.checkpointRepo

.findLatest(accountId);

// 2. Buscar transacoes apos o checkpoint (ou todas se nao ha checkpoint)

const cutoffDate = checkpoint?.reference_date

? new Date(checkpoint.reference_date + 'T23:59:59.999Z')

: new Date(0); // epoch = pegar tudo

const deltaResult = await this.db.query(\`

SELECT

COALESCE(SUM(

CASE WHEN type = 'CREDIT' THEN amount

WHEN type = 'DEBIT' THEN -amount

END

), 0)::bigint AS delta,

COUNT(\*)::int AS tx_count

FROM transactions

WHERE account_id = \$1

AND created_at > \$2

\`, \[accountId, cutoffDate\]);

const checkpointBalance = checkpoint?.balance ?? cents(0);

const delta = cents(Number(deltaResult.rows\[0\].delta));

const txCount = deltaResult.rows\[0\].tx_count;

// 3. Saldo = checkpoint + delta

const balance = cents(

(checkpointBalance as number) + (delta as number)

);

return {

balance,

checkpoint_date: checkpoint?.reference_date ?? null,

transactions_after_checkpoint: txCount,

calculated_at: new Date(),

};

}

}

## **4.3 Query SQL Otimizada (Single Query)**

Para producao, a abordagem preferida e uma unica query que faz o join entre checkpoint e transacoes:

\-- Query unica: checkpoint + delta em um so round-trip

WITH latest_checkpoint AS (

SELECT balance, reference_date

FROM checkpoints

WHERE account_id = \$1

ORDER BY reference_date DESC

LIMIT 1

),

delta AS (

SELECT

COALESCE(SUM(

CASE WHEN t.type = 'CREDIT' THEN t.amount

WHEN t.type = 'DEBIT' THEN -t.amount

END

), 0)::bigint AS total,

COUNT(\*)::int AS tx_count

FROM transactions t

WHERE t.account_id = \$1

AND t.created_at > COALESCE(

(SELECT (reference_date + INTERVAL '1 day' - INTERVAL '1 ms')

FROM latest_checkpoint),

'1970-01-01'::timestamptz

)

)

SELECT

COALESCE(lc.balance, 0) + d.total AS current_balance,

lc.reference_date AS checkpoint_date,

d.tx_count AS pending_transactions

FROM delta d

LEFT JOIN latest_checkpoint lc ON true;

## **4.4 Prova de Consistencia**

O modelo e consistente porque:

- A formula e deterministica: dados os mesmos inputs (checkpoint + transacoes), sempre produz o mesmo resultado.
- O checkpoint e um snapshot imutavel: uma vez criado, nunca muda (UNIQUE constraint em account_id + reference_date).
- Transacoes sao imutaveis: triggers impedem UPDATE/DELETE.
- A janela de tempo e precisa: transacoes posteriores ao checkpoint sao filtradas por created_at > checkpoint.reference_date (end of day).
- Concorrencia e tratada: advisory locks impedem que duas transacoes concorrentes criem estado inconsistente durante o calculo.

## **4.5 Limitacoes do Modelo**

| **Limitacao**                    | **Impacto**                                    | **Mitigacao**                                           |
| -------------------------------- | ---------------------------------------------- | ------------------------------------------------------- |
| Checkpoint depende de cron       | Se o cron falhar, mais txs para somar          | Monitoramento + retry + checkpoint_executions           |
| Leitura nao e snapshot isolation | Tx inserida durante calculo pode ou nao entrar | Advisory lock na conta durante calculo critico          |
| Checkpoint nao e atomico com txs | Janela de ms entre snapshot e proxima tx       | Gravar last_transaction_id no checkpoint para ancoragem |
| Alta frequencia de txs           | Delta pos-checkpoint cresce rapido             | Checkpoints mais frequentes (a cada hora)               |

## **4.6 Alternativa: Full Event Sourcing**

Em um modelo de event sourcing puro, cada transacao seria um evento e o saldo seria uma projecao reconstruida a partir dos eventos. A vantagem e consistencia absoluta. A desvantagem e complexidade operacional (event store dedicado, snapshots, projecoes). O modelo de checkpoint proposto e um meio-termo pragmatico que oferece 95% dos beneficios com 50% da complexidade.

# **5\. Cronjob e Consistencia**

## **5.1 Estrategia do Checkpoint**

O cronjob executa diariamente as 00:30 UTC (evita meia-noite exata por contenction de fim de dia). Ele consolida o saldo de cada conta ate o dia anterior (reference_date = ontem).

### **5.1.1 Fluxo Detalhado**

// src/services/checkpoint.service.ts

export class CheckpointService {

async runDailyCheckpoint(): Promise&lt;void&gt; {

const referenceDate = this.getYesterday(); // YYYY-MM-DD

const executionId = generateId('exec');

// 1. Registrar execucao (idempotencia)

const canProceed = await this.registerExecution(

executionId, referenceDate

);

if (!canProceed) {

logger.warn('Checkpoint ja executado para', referenceDate);

return; // Idempotente: nao reprocessa

}

// 2. Adquirir lock global para checkpoint

const lockAcquired = await this.db.query(

'SELECT pg_try_advisory_lock(\$1)',

\[CHECKPOINT_LOCK_ID\] // constante: 999999

);

if (!lockAcquired.rows\[0\].pg_try_advisory_lock) {

throw new Error('Outro processo ja esta gerando checkpoint');

}

try {

// 3. Listar todas as contas ativas

const accounts = await this.accountRepo.findAllActive();

// 4. Para cada conta, gerar checkpoint

for (const account of accounts) {

await this.generateAccountCheckpoint(

account.id, referenceDate

);

}

// 5. Marcar execucao como concluida

await this.markExecutionCompleted(executionId);

} catch (error) {

await this.markExecutionFailed(executionId, error);

throw error;

} finally {

await this.db.query(

'SELECT pg_advisory_unlock(\$1)',

\[CHECKPOINT_LOCK_ID\]

);

}

}

private async generateAccountCheckpoint(

accountId: AccountId,

referenceDate: string

): Promise&lt;void&gt; {

// Verificar se ja existe checkpoint para esta data

const existing = await this.checkpointRepo

.findByAccountAndDate(accountId, referenceDate);

if (existing) return; // Idempotente por conta

const cutoff = new Date(referenceDate + 'T23:59:59.999Z');

// Calcular saldo consolidado em uma unica transacao

const result = await this.db.query(\`

SELECT

COALESCE(SUM(

CASE WHEN type = 'CREDIT' THEN amount

WHEN type = 'DEBIT' THEN -amount

END

), 0)::bigint AS balance,

MAX(id) AS last_tx_id,

COUNT(\*)::int AS tx_count

FROM transactions

WHERE account_id = \$1

AND created_at <= \$2

\`, \[accountId, cutoff\]);

// Considerar checkpoint anterior (se existir)

const prevCheckpoint = await this.checkpointRepo

.findLatestBefore(accountId, referenceDate);

// Se nao ha transacoes e nao ha checkpoint anterior, skip

const balance = prevCheckpoint

? cents(Number(prevCheckpoint.balance) + Number(result.rows\[0\].balance))

: cents(Number(result.rows\[0\].balance));

// Gerar checksum para verificacao

const checksum = sha256(

\`\${accountId}|\${balance}|\${referenceDate}|\${result.rows\[0\].last_tx_id}\`

);

await this.checkpointRepo.create({

id: generateId('chk'),

account_id: accountId,

balance,

reference_date: referenceDate,

last_transaction_id: result.rows\[0\].last_tx_id,

transaction_count: result.rows\[0\].tx_count,

checksum,

});

}

}

## **5.2 Idempotencia e Protecao contra Duplicacao**

A protecao contra execucao duplicada do cronjob opera em tres camadas:

| **Camada**                     | **Mecanismo**                                                  | **Escopo**    |
| ------------------------------ | -------------------------------------------------------------- | ------------- |
| 1\. checkpoint_executions      | UNIQUE(reference_date) impede duplicar registro                | Por dia       |
| 2\. pg_advisory_lock           | Lock global impede execucao paralela                           | Por processo  |
| 3\. uq_checkpoint_account_date | UNIQUE(account_id, reference_date) impede checkpoint duplicado | Por conta/dia |

## **5.3 Recuperacao de Falha**

Se o cronjob falha no meio da execucao (ex: crash apos processar 500 de 1000 contas):

- O registro em checkpoint_executions fica com status = RUNNING.
- Um processo de recovery roda a cada 5 minutos, detectando execucoes RUNNING com started_at > 10 min atras.
- O recovery reprocessa a mesma reference_date. Contas que ja tem checkpoint sao puladas (idempotencia por UNIQUE constraint).
- Apenas as contas restantes sao processadas.

// Recovery: detecta execucoes travadas

SELECT \* FROM checkpoint_executions

WHERE status = 'RUNNING'

AND started_at < now() - INTERVAL '10 minutes';

## **5.4 Consistencia durante Geracao**

**IMPORTANTE:** Durante a geracao do checkpoint, novas transacoes podem ser inseridas. Isso NAO causa inconsistencia porque: (a) o checkpoint consolida ate reference_date (ontem), (b) transacoes de hoje nao sao incluidas no checkpoint, (c) o calculo de saldo atual soma checkpoint + transacoes APOS o checkpoint. A janela de tempo e clara e nao ha overlap.

# **6\. Design da API**

## **6.1 Endpoints**

| **Metodo** | **Path**                   | **Descricao**                    |
| ---------- | -------------------------- | -------------------------------- |
| POST       | /accounts                  | Criar conta                      |
| GET        | /accounts/:id              | Detalhes da conta                |
| POST       | /accounts/:id/transactions | Inserir transacao (CREDIT/DEBIT) |
| GET        | /accounts/:id/balance      | Calcular saldo atual             |
| GET        | /accounts/:id/statement    | Extrato com paginacao            |
| POST       | /admin/checkpoints/run     | Forcar checkpoint (admin)        |
| GET        | /admin/checkpoints/status  | Status da ultima execucao        |
| GET        | /health                    | Health check                     |

## **6.2 Implementacao com Elysia**

### **6.2.1 Setup Principal**

// src/index.ts

import { Elysia } from 'elysia';

import { accountRoutes } from './routes/account.routes';

import { transactionRoutes } from './routes/transaction.routes';

import { balanceRoutes } from './routes/balance.routes';

import { adminRoutes } from './routes/admin.routes';

import { errorHandler } from './middleware/error-handler';

const app = new Elysia()

.use(errorHandler)

.use(accountRoutes)

.use(transactionRoutes)

.use(balanceRoutes)

.use(adminRoutes)

.get('/health', () => ({ status: 'ok', timestamp: new Date() }))

.listen(3000);

console.log('Ledger API running on port 3000');

### **6.2.2 Rota de Transacao**

// src/routes/transaction.routes.ts

import { Elysia, t } from 'elysia';

export const transactionRoutes = new Elysia({ prefix: '/accounts' })

.post('/:accountId/transactions', async ({ params, body, set }) => {

const { accountId } = params;

const { type, amount, description, idempotency_key } = body;

// 1. Validar conta existe e esta ativa

const account = await accountService.findById(accountId);

if (!account) {

set.status = 404;

return { error: 'ACCOUNT_NOT_FOUND' };

}

if (account.status !== 'ACTIVE') {

set.status = 422;

return { error: 'ACCOUNT_NOT_ACTIVE', status: account.status };

}

// 2. Idempotencia: verificar se ja existe tx com esta key

const existing = await txService.findByIdempotencyKey(idempotency_key);

if (existing) {

set.status = 200; // 200, nao 201 (ja existia)

return existing;

}

// 3. Adquirir advisory lock na conta

// Isso previne race conditions de saldo negativo

const lockKey = hashToInt(accountId);

await db.query('SELECT pg_advisory_xact_lock(\$1)', \[lockKey\]);

// 4. Validar saldo se DEBIT

if (type === 'DEBIT') {

const { balance } = await balanceService.getBalance(accountId);

if (balance < amount) {

set.status = 422;

return {

error: 'INSUFFICIENT_BALANCE',

current_balance: balance,

requested: amount,

};

}

}

// 5. Inserir transacao (append-only)

const tx = await txService.create({

account_id: accountId,

type,

amount: cents(amount),

description: description ?? '',

idempotency_key,

});

set.status = 201;

return tx;

}, {

params: t.Object({

accountId: t.String({ pattern: '^acc\_\[a-zA-Z0-9\]{20}\$' }),

}),

body: t.Object({

type: t.Union(\[t.Literal('CREDIT'), t.Literal('DEBIT')\]),

amount: t.Integer({ minimum: 1, maximum: 99999999999 }),

description: t.Optional(t.String({ maxLength: 500 })),

idempotency_key: t.String({ minLength: 1, maxLength: 100 }),

}),

});

### **6.2.3 Rota de Saldo**

// src/routes/balance.routes.ts

import { Elysia, t } from 'elysia';

export const balanceRoutes = new Elysia({ prefix: '/accounts' })

.get('/:accountId/balance', async ({ params }) => {

const result = await balanceService.getBalance(params.accountId);

return {

account_id: params.accountId,

balance: result.balance,

balance_formatted: formatCurrency(result.balance, 'BRL'),

checkpoint_date: result.checkpoint_date,

pending_transactions: result.transactions_after_checkpoint,

calculated_at: result.calculated_at.toISOString(),

};

}, {

params: t.Object({

accountId: t.String({ pattern: '^acc\_\[a-zA-Z0-9\]{20}\$' }),

}),

});

### **6.2.4 Rota de Extrato**

// src/routes/balance.routes.ts (continuacao)

.get('/:accountId/statement', async ({ params, query }) => {

const { accountId } = params;

const { from, to, cursor, limit = 50 } = query;

// Cursor-based pagination (nao offset!)

const transactions = await txRepo.findByAccount(accountId, {

from: from ? new Date(from) : undefined,

to: to ? new Date(to) : undefined,

cursor, // id da ultima tx da pagina anterior

limit: Math.min(limit, 100),

});

// Calcular running balance para cada tx no extrato

const statement = await enrichWithRunningBalance(

accountId, transactions

);

return {

account_id: accountId,

transactions: statement,

pagination: {

has_more: transactions.length === limit,

next_cursor: transactions.length > 0

? transactions\[transactions.length - 1\].id

: null,

},

};

}, {

params: t.Object({

accountId: t.String({ pattern: '^acc\_\[a-zA-Z0-9\]{20}\$' }),

}),

query: t.Object({

from: t.Optional(t.String({ format: 'date' })),

to: t.Optional(t.String({ format: 'date' })),

cursor: t.Optional(t.String()),

limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),

}),

});

## **6.3 Error Handling**

// src/middleware/error-handler.ts

import { Elysia } from 'elysia';

export const errorHandler = new Elysia()

.onError(({ error, set }) => {

if (error instanceof DomainError) {

set.status = 422;

return {

error: error.code,

message: error.message,

timestamp: new Date().toISOString(),

};

}

// Log interno, nao expor detalhes

logger.error('Unhandled error', { error });

set.status = 500;

return {

error: 'INTERNAL_ERROR',

message: 'An unexpected error occurred',

timestamp: new Date().toISOString(),

};

});

# **7\. Problemas Reais**

## **7.1 Concorrencia de Transacoes**

Problema: duas requisicoes simultaneas de DEBIT de R\$ 500 em uma conta com saldo de R\$ 800. Sem protecao, ambas passam na validacao e o saldo fica negativo.

Solucao: pg_advisory_xact_lock por account_id. O lock e automaticamente liberado no fim da transacao SQL.

// Fluxo com lock:

// Request A: pg_advisory_xact_lock(hash('acc_xxx')) -> adquire

// Request B: pg_advisory_xact_lock(hash('acc_xxx')) -> ESPERA

// Request A: verifica saldo (800), debita 500, commit -> libera lock

// Request B: adquire lock, verifica saldo (300), debita 500 -> REJEITA (saldo insuficiente)

**IMPORTANTE:** Usamos pg_advisory_xact_lock (nao pg_advisory_lock) porque o primeiro e liberado automaticamente no COMMIT/ROLLBACK. O segundo requer UNLOCK explicito, que pode ser esquecido em caso de erro.

## **7.2 Execucao Duplicada do Cronjob**

Problema: se o scheduler dispara o cronjob duas vezes (deploy, restart, bug no cron), checkpoints podem ser gerados em duplicata ou com dados inconsistentes.

Solucao em tres camadas:

- checkpoint_executions.reference_date e UNIQUE: INSERT falha se ja existe registro para o dia.
- pg_try_advisory_lock: segundo processo detecta que lock ja esta tomado e aborta sem erro.
- checkpoints(account_id, reference_date) e UNIQUE: mesmo que passe as duas camadas anteriores, o banco rejeita duplicatas.

## **7.3 Falha durante Checkpoint**

Problema: o processo crasheia apos gerar checkpoint para 500 de 1000 contas.

Solucao: o recovery process detecta execucoes RUNNING com timeout e reprocessa. Como cada checkpoint individual e idempotente (UNIQUE constraint), as 500 contas ja processadas sao puladas e apenas as restantes sao geradas.

## **7.4 Alta Quantidade de Transacoes**

Problema: conta com 10M+ transacoes. Somar todas e inviavel.

Solucao: checkpoints diarios limitam o delta a no maximo 24h de transacoes. Para contas de altissimo volume, implementar checkpoints a cada hora via configuracao por conta.

\-- Checkpoint horario para contas de alto volume

\-- O mesmo mecanismo, com reference_date granular

ALTER TABLE checkpoints ADD COLUMN granularity TEXT

DEFAULT 'DAILY' CHECK (granularity IN ('DAILY', 'HOURLY'));

## **7.5 Idempotencia de Transacoes**

Problema: cliente reenvia POST por timeout de rede. Sem protecao, a transacao e duplicada.

Solucao: idempotency_key com UNIQUE index. Se a key ja existe, retornamos a transacao existente com HTTP 200 (nao 201). O cliente recebe o mesmo resultado independente de quantas vezes enviar.

# **8\. Validacao do Modelo**

## **8.1 Cenario de Teste**

Conta: acc_test0000000000000001, Currency: BRL

### **8.1.1 Transacoes**

| **#** | **Data/Hora**       | **Tipo** | **Valor (centavos)** | **Descricao**                  |
| ----- | ------------------- | -------- | -------------------- | ------------------------------ |
| tx_1  | 2026-03-15 10:00:00 | CREDIT   | 100000               | Deposito inicial (R\$1.000,00) |
| tx_2  | 2026-03-15 14:30:00 | DEBIT    | 20000                | Pagamento boleto (R\$200,00)   |
| tx_3  | 2026-03-16 09:00:00 | DEBIT    | 10000                | Transferencia PIX (R\$100,00)  |
| tx_4  | 2026-03-16 15:00:00 | CREDIT   | 5000                 | Cashback recebido (R\$50,00)   |

### **8.1.2 Checkpoint (gerado em 2026-03-16 00:30 UTC, ref_date = 2026-03-15)**

O cronjob roda as 00:30 do dia 16 e consolida todas as transacoes ate 15/03 23:59:59.999:

Transacoes incluidas no checkpoint:

tx_1: CREDIT +100000

tx_2: DEBIT -20000

─────────────────────

checkpoint.balance = 100000 - 20000 = 80000 (R\$800,00)

checkpoint.reference_date = '2026-03-15'

checkpoint.last_transaction_id = 'tx_2'

checkpoint.transaction_count = 2

### **8.1.3 Calculo do Saldo Atual (consultado em 2026-03-16 16:00)**

Passo 1: Buscar checkpoint mais recente

\-> checkpoint.balance = 80000, reference_date = '2026-03-15'

Passo 2: Buscar transacoes APOS 2026-03-15 23:59:59.999

\-> tx_3: DEBIT -10000 (created_at: 2026-03-16 09:00)

\-> tx_4: CREDIT +5000 (created_at: 2026-03-16 15:00)

\-> delta = -10000 + 5000 = -5000

Passo 3: Saldo = checkpoint + delta

\-> saldo = 80000 + (-5000) = 75000

RESULTADO: R\$750,00 (75000 centavos)

### **8.1.4 Verificacao de Consistencia**

Para provar que o modelo e correto, calculamos o saldo de duas formas:

Metodo 1 (via checkpoint + delta):

80000 + (-10000 + 5000) = 75000 ✓

Metodo 2 (soma total, sem checkpoint):

tx_1: +100000

tx_2: -20000

tx_3: -10000

tx_4: +5000

───────────────

Total: 75000 ✓

Ambos os metodos produzem 75000 centavos (R\$750,00).

O modelo e consistente. ✓

## **8.2 Validacao das Regras de Dominio**

| **Regra**                    | **Status** | **Evidencia**                                                  |
| ---------------------------- | ---------- | -------------------------------------------------------------- |
| Append-only                  | OK         | Trigger prevent_mutation() bloqueia UPDATE/DELETE              |
| Nunca atualizar transacoes   | OK         | Trigger + ausencia de operacoes UPDATE no codigo               |
| Saldo nao e fonte de verdade | OK         | Nao existe coluna 'balance' em accounts                        |
| Saldo sempre derivado        | OK         | BalanceService.getBalance() calcula a cada chamada             |
| Valores em inteiros          | OK         | BIGINT no banco, branded type Cents no TS, CHECK(amount > 0)   |
| Imutabilidade do ledger      | OK         | 3 camadas: trigger SQL + ausencia de mutations + branded types |

## **8.3 Teste de Edge Cases**

### **8.3.1 Conta sem Checkpoint**

// Conta recem-criada, sem checkpoint, 2 transacoes

checkpoint = null (nao existe)

cutoffDate = epoch (1970-01-01)

\-> Soma TODAS as transacoes da conta

\-> delta = SUM(todas) = saldo correto ✓

### **8.3.2 Conta sem Transacoes**

// Conta criada, nenhuma transacao

checkpoint = null

delta = 0 (nenhuma tx)

saldo = 0 + 0 = 0 ✓

### **8.3.3 Transacao durante Geracao de Checkpoint**

// Cenario:

// 00:30:00.000 - Cron comeca, ref_date = ontem

// 00:30:00.050 - Cron calcula: SUM(txs ate ontem 23:59:59.999)

// 00:30:00.100 - Nova tx (tx_5) inserida (created_at = hoje)

// 00:30:00.200 - Cron salva checkpoint

// Resultado: tx_5 NAO entra no checkpoint (created_at > ref_date)

// tx_5 sera incluida no delta no proximo calculo de saldo

// Consistencia mantida ✓

# **9\. Melhorias Futuras**

## **9.1 Event Sourcing Completo**

Migrar o ledger para um event store dedicado (ex: EventStoreDB ou Kafka + schema registry). Cada transacao vira um evento imutavel com schema versionado. Saldo vira uma projecao reconstruida a partir do stream de eventos. Vantagens: replay completo, time-travel queries, multi-consumer. Custo: complexidade operacional significativa, necessidade de team com experiencia em event sourcing.

| **Aspecto**           | **Modelo Atual**        | **Event Sourcing**                   |
| --------------------- | ----------------------- | ------------------------------------ |
| Fonte de verdade      | PostgreSQL transactions | Event stream (Kafka/ESDB)            |
| Reconstrucao de saldo | Checkpoint + delta      | Replay do stream inteiro ou snapshot |
| Auditoria             | Query na tabela         | Stream replay nativo                 |
| Complexidade ops      | Baixa (PostgreSQL)      | Alta (cluster dedicado)              |
| Latencia de leitura   | ~5ms (com checkpoint)   | ~1ms (projecao pre-computada)        |

## **9.2 CQRS (Command Query Responsibility Segregation)**

Separar os modelos de escrita (commands: inserir transacao) e leitura (queries: saldo, extrato) em datastores diferentes. A escrita continua no PostgreSQL (forte consistencia). A leitura vai para um datastore otimizado (Redis, DynamoDB, ou uma read replica com materialized views).

// Arquitetura CQRS:

// WRITE PATH: API -> PostgreSQL (transacoes)

// -> Event emitido (via pg_notify ou Change Data Capture)

//

// READ PATH: API -> Redis/ReadReplica (saldo pre-calculado)

// -> Atualizado assincronamente via consumer de eventos

//

// Trade-off: eventual consistency na leitura (~100ms delay)

// mas throughput de leitura 100x maior

## **9.3 Particionamento Avancado**

Alem do particionamento mensal por created_at ja implementado:

- **Sharding por account_id:** Distribuir contas em shards fisicos (ex: Citus ou sharding manual). Necessario quando o volume de contas ultrapassa a capacidade de uma unica instancia PostgreSQL.
- **Tiered storage:** Mover particoes antigas (>12 meses) para object storage (S3) com query engine (Athena/Trino). Reduz custo de armazenamento em 90%.
- **Hot/Cold partitions:** Particoes dos ultimos 3 meses em SSD, anteriores em HDD. Configuravel no PostgreSQL via tablespaces.

## **9.4 Estrategias de Escala**

### **9.4.1 Fase 1: Vertical (ate ~10K TPS)**

- PostgreSQL otimizado: connection pooling (PgBouncer), tuning de shared_buffers, work_mem
- Read replicas para queries de extrato e relatorios
- Redis cache para saldos recentes (TTL 5s, invalidado por transacao)

### **9.4.2 Fase 2: Horizontal (10K-100K TPS)**

- Sharding por account_id (Citus ou manual)
- CQRS: datastore separado para leituras
- Event streaming: Kafka para desacoplar escrita de projecoes

### **9.4.3 Fase 3: Planet-Scale (100K+ TPS)**

- CockroachDB ou Spanner para distributed transactions
- Event sourcing dedicado (EventStoreDB cluster)
- Lambda architecture: batch (checkpoints) + speed (stream processing)

## **9.5 Double-Entry Bookkeeping**

Para suportar contabilidade completa, cada transacao deveria gerar dois lancamentos (debito e credito em contas diferentes). Exemplo: transferencia de R\$ 100 de conta A para conta B gera:

// Double-entry:

// Lancamento 1: DEBIT acc_A -10000 (saiu de A)

// Lancamento 2: CREDIT acc_B +10000 (entrou em B)

//

// Invariante: SUM(todos os lancamentos no sistema) == 0

//

// Implementacao: adicionar campo 'entry_group_id' para agrupar

// lancamentos que pertencem a mesma operacao.

Isso garante que dinheiro nunca e criado ou destruido, apenas movido entre contas. E o padrao ouro de contabilidade e recomendado para a proxima versao.

## **9.6 Observabilidade**

- Structured logging (JSON) com correlation IDs em toda a cadeia
- Metricas Prometheus: latencia de calculo de saldo, taxa de transacoes, tamanho do delta pos-checkpoint
- Alertas: checkpoint atrasado > 2h, delta > 10K transacoes, taxa de erro > 1%
- Distributed tracing (OpenTelemetry) para rastrear uma transacao do HTTP ate o banco

**FIM DO RFC-001**

Este documento deve ser revisado pelo time de arquitetura antes da implementacao. Qualquer desvio das decisoes aqui documentadas deve ser registrado como ADR (Architecture Decision Record).

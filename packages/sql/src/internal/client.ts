import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as DefaultServices from "effect/DefaultServices"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FiberRef from "effect/FiberRef"
import * as Option from "effect/Option"
import * as Scope from "effect/Scope"
import * as Tracer from "effect/Tracer"
import type * as Client from "../SqlClient.js"
import type * as Connection from "../SqlConnection.js"
import type * as Error from "../SqlError.js"
import * as Statement from "../Statement.js"

/** @internal */
export const TypeId: Client.TypeId = Symbol.for("@effect/sql/SqlClient") as Client.TypeId

/** @internal */
export const clientTag = Context.GenericTag<Client.SqlClient>("@effect/sql/SqlClient")

/** @internal */
export const TransactionConnection = Context.GenericTag<
  Client.TransactionConnection,
  readonly [conn: Connection.Connection, counter: number]
>("@effect/sql/SqlClient/TransactionConnection")

/** @internal */
export function make({
  acquirer,
  beginTransaction = "BEGIN",
  commit = "COMMIT",
  compiler,
  rollback = "ROLLBACK",
  rollbackSavepoint = (id) => `ROLLBACK TO SAVEPOINT ${id}`,
  savepoint = (id) => `SAVEPOINT ${id}`,
  spanAttributes,
  transactionAcquirer
}: Client.SqlClient.MakeOptions): Client.SqlClient {
  const getConnection = Effect.flatMap(
    Effect.serviceOption(TransactionConnection),
    Option.match({
      onNone: () => acquirer,
      onSome: ([conn]) => Effect.succeed(conn)
    })
  )

  const getTxConn: Effect.Effect<
    readonly [Scope.CloseableScope | undefined, Connection.Connection],
    Error.SqlError
  > = Effect.flatMap(
    Scope.make(),
    (scope) => Effect.map(Scope.extend(transactionAcquirer, scope), (conn) => [scope, conn] as const)
  )

  const withTransaction = <R, E, A>(
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E | Error.SqlError, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.useSpan(
        "sql.transaction",
        { kind: "client", captureStackTrace: false },
        (span) =>
          Effect.withFiberRuntime<A, E | Error.SqlError, R>((fiber) => {
            for (const [key, value] of spanAttributes) {
              span.attribute(key, value)
            }
            const context = fiber.getFiberRef(FiberRef.currentContext)
            const clock = Context.get(fiber.getFiberRef(DefaultServices.currentServices), Clock.Clock)
            const connOption = Context.getOption(context, TransactionConnection)
            const conn = connOption._tag === "Some"
              ? Effect.succeed([undefined, connOption.value[0]] as const)
              : getTxConn
            const id = connOption._tag === "Some" ? connOption.value[1] + 1 : 0
            return Effect.flatMap(
              conn,
              (
                [scope, conn]
              ) =>
                conn.executeUnprepared(id === 0 ? beginTransaction : savepoint(`effect_sql_${id}`)).pipe(
                  Effect.zipRight(Effect.locally(
                    restore(effect),
                    FiberRef.currentContext,
                    Context.add(context, TransactionConnection, [conn, id]).pipe(
                      Context.add(Tracer.ParentSpan, span)
                    )
                  )),
                  Effect.exit,
                  Effect.flatMap((exit) => {
                    let effect: Effect.Effect<void>
                    if (Exit.isSuccess(exit)) {
                      if (id === 0) {
                        span.event("db.transaction.commit", clock.unsafeCurrentTimeNanos())
                        effect = Effect.orDie(conn.executeUnprepared(commit))
                      } else {
                        span.event("db.transaction.savepoint", clock.unsafeCurrentTimeNanos())
                        effect = Effect.void
                      }
                    } else {
                      span.event("db.transaction.rollback", clock.unsafeCurrentTimeNanos())
                      effect = Effect.orDie(
                        id > 0
                          ? conn.executeUnprepared(rollbackSavepoint(`effect_sql_${id}`))
                          : conn.executeUnprepared(rollback)
                      )
                    }
                    const withScope = scope !== undefined ? Effect.ensuring(effect, Scope.close(scope, exit)) : effect
                    return Effect.zipRight(withScope, exit)
                  })
                )
            )
          })
      )
    )

  const client: Client.SqlClient = Object.assign(
    Statement.make(getConnection, compiler, spanAttributes),
    {
      [TypeId as Client.TypeId]: TypeId as Client.TypeId,
      safe: undefined as any,
      withTransaction,
      reserve: transactionAcquirer
    }
  )
  ;(client as any).safe = client

  return client
}

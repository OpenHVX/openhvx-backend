//types/amqplib.d.ts
declare module "amqplib" {
    import { EventEmitter } from "events";

    export namespace Options {
        interface MessagePropertyHeaders {
            [key: string]: unknown;
        }

        interface Publish {
            contentType?: string;
            deliveryMode?: number;
            correlationId?: string;
        }
    }

    export interface ConsumeMessage {
        content: Buffer;
        fields: {
            routingKey: string;
        };
        properties: {
            headers?: Options.MessagePropertyHeaders;
        };
    }

    export interface Channel extends EventEmitter {
        assertExchange(exchange: string, type: string, options?: unknown): Promise<void>;
        assertQueue(queue: string, options?: unknown): Promise<void>;
        bindQueue(queue: string, source: string, pattern: string): Promise<void>;
        publish(exchange: string, routingKey: string, content: Buffer, options?: Options.Publish): boolean;
        consume(
            queue: string,
            onMessage: (msg: ConsumeMessage | null) => void,
            options?: { noAck?: boolean }
        ): Promise<void>;
        ack(message: ConsumeMessage): void;
        nack(message: ConsumeMessage, allUpTo?: boolean, requeue?: boolean): void;
        prefetch(count: number): Promise<void>;
    }

    export interface Connection extends EventEmitter {
        createChannel(): Promise<Channel>;
    }

    export function connect(url?: string): Promise<Connection>;
}

import path from "node:path";
import swaggerJsdoc from "swagger-jsdoc";

const routesPathJs = path.join(__dirname, "..", "routes", "**", "*.js");
const routesPathTs = path.join(__dirname, "..", "routes", "**", "*.ts");

const swaggerOptions = {
    definition: {
        openapi: "3.0.3",
        info: {
            title: "OpenHVX API Gateway",
            version: "1.0.0",
            description:
                "API Gateway for OpenHVX platform, providing access to various resources and services.",
        },
        servers: [{ url: "/" }],
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: "http",
                    scheme: "bearer",
                    bearerFormat: "JWT",
                    description: "JWT included in Authorization: Bearer <token>",
                },
            },
        },
        security: [{ bearerAuth: [] }],
    },
    apis: [routesPathJs, routesPathTs],
};

export const swaggerSpec = swaggerJsdoc(swaggerOptions);

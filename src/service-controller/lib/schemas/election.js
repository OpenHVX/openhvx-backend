// lib/schemas/election.js
const { objectStrict, arrayOf, isString, isInteger, isDate } = require("../validate");

const AgentsSchema = objectStrict({
    requirements: objectStrict({
        freshness: isInteger,
        capabilities: arrayOf(isString),
    }),
});

module.exports = { AgentsSchema };

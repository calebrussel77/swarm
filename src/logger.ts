import winston from 'winston'
import util from 'util'
import { colorize } from 'json-colorizer'
import 'dotenv/config'

function prettyPrintArgs(args: any[]): any[] {
    if (args) {
        return args.map((arg) => {
            // Check if the arg is a complex object (not null and typeof object)
            if (arg !== null && typeof arg === 'object') {
                // Pretty print the object using JSON.stringify with indentation
                //return JSON.stringify(arg, null, 2);
                return colorize(arg)
            }
            // If not an object, return the value as-is
            return arg
        })
    } else {
        return args
    }
}

//From:
//https://stackoverflow.com/questions/55387738/how-to-make-winston-logging-library-work-like-console-log

function transform(info: any, opts: object) {
    const args = prettyPrintArgs(info[Symbol.for('splat')])

    if (args) {
        info.message = util.format(info.message, ...args)
    }
    return info
}

function utilFormatter() {
    return { transform }
}

// The following comes from here:
// https://github.com/winstonjs/winston/issues/1427#issuecomment-811184784)
// It's basically the same as utilFormatter()
const combineMessageAndSplat = () => {
    return {
        transform: (info: any, opts: object) => {
            //combine message and args if any
            info.message = util.format(info.message, ...(info[Symbol.for('splat')] || []))
            return info
        },
    }
}

const usCentralTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    fractionalSecondDigits: 3, // This adds millisecond precision (3 digits)
    hour12: true,
})

// This is a version of the Simple formatter that doesn't
// handle objects the same way.
// The OOTB simple formatter (see node_modules/logform/simple.js)
// is written to handle complex objects passed to the logger by
// stringifying anything that isn't 'level', 'message', or 'splat',
// and appending that string to the log message.
// In our case, this yields a double-printing of objects, when objects
// are passed into the log message.
// This simplified version sacrifices that functionailty that we don't
// need for a better experience in the more common use case of an object
// being passed as the argument to the log message.
const realSimple = (filename?: string) => {
    const fileBlock = filename ? ` [${filename}]` : ``
    return {
        transform: (info: any, opts: object) => {
            info[Symbol.for('message')] =
                `[${usCentralTime.format(new Date())}]${fileBlock} ${info.level}: ${info.message}`
            return info
        },
    }
}

// For reference, levels are as follows:
// {
//   error: 0,
//   warn: 1,
//   info: 2,
//   http: 3,
//   verbose: 4,
//   debug: 5,
//   silly: 6
// }

const consoleTransport = new winston.transports.Console()
const prettyPrint = winston.format.prettyPrint()
const uf = utilFormatter()
const colorizer = winston.format.colorize({ all: false })

//Set up the logger
export const logger = createLogger()

/**
 * Create a logger for the current file
 * @param fileName
 * @param color
 * @param transports
 */
export function createLogger(fileName?: string, color?: boolean, transports: Array<any>=[]) {
    const shortenedFilename: string | undefined = fileName && formatFilename(fileName.split('/').slice(-1)[0])

    const formatters = [
        winston.format.prettyPrint(),
        utilFormatter(),
        realSimple(shortenedFilename)
    ]
    if (color) formatters.push(winston.format.colorize({ all: false }))
    if (!transports || !transports.length) transports.push(new winston.transports.Console())

    return winston.createLogger({
        level: process.env.LOG_LEVEL || 'info',
        // @ts-expect-error - formatters work!
        format: winston.format.combine(...formatters),
        transports: transports,
    })
}

//... and export it
export default logger

function formatFilename(filename: string): string {
    const maxLength = 21

    if (filename.length <= maxLength) {
        // Pad the filename with spaces to reach 20 characters
        return filename.padEnd(maxLength)
    } else {
        // Calculate the number of characters to keep on each side of the ellipsis
        const charsToKeep = Math.floor((maxLength - 3) / 2)

        // Extract the characters to keep from the beginning and end of the filename
        const start = filename.slice(0, charsToKeep)
        const end = filename.slice(filename.length - charsToKeep)

        // Combine the start, ellipsis, and end parts
        return start + '...' + end
    }
}
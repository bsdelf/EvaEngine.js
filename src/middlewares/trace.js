import onHeaders from 'on-headers';
import { Dependencies } from 'constitute';
import { randomString, getHostFullUrl, getHostPort, getHostIp, getMicroTimestamp } from '../utils';
import Namespace from '../services/namespace';
import Config from '../services/config';
import Logger from '../services/logger';
import HttpClient from '../services/http_client';

const hostIp = getHostIp();

export const tracerToZipkins = (tracer) => {
  if (!tracer) {
    return false;
  }
  const {
    url,
    method,
    serviceName,
    spanId: id,
    traceId,
    parentId,
    timestamp,
    duration,
    statusCode,
    port,
    queries
  } = tracer;

  const name = `${statusCode} ${method} ${url}`;
  const endpoint = {
    serviceName,
    ipv4: hostIp,
    port
  };
  const zipkin = {
    id,
    traceId,
    name,
    timestamp,
    duration,
    annotations: [
      {
        endpoint,
        timestamp,
        value: 'sr'
      },
      {
        endpoint,
        timestamp: timestamp + duration,
        value: 'ss'
      }
    ],
    binaryAnnotations: [
      {
        key: 'traceId',
        value: traceId
      },
      {
        key: 'spanId',
        value: id
      },
      {
        key: 'method',
        value: method
      },
      {
        key: 'url',
        value: url
      },
      {
        key: 'port',
        value: port.toString()
      },
      {
        key: 'statusCode',
        value: statusCode.toString()
      }
    ]
  };

  if (parentId) {
    zipkin.parentId = parentId;
  }

  const zipkins = [zipkin];
  if (queries && queries.length > 0) {
    queries.forEach((element) => {
      const { query, cost, finishedAt } = element;
      zipkins.push({
        id: randomString(),
        parentId: id,
        traceId,
        name: 'sequelize',
        timestamp: finishedAt - cost,
        duration: cost,
        annotations: [
          {
            endpoint,
            timestamp: finishedAt - cost,
            value: 'cs'
          },
          {
            endpoint,
            timestamp: finishedAt,
            value: 'cr'
          }
        ],
        binaryAnnotations: [{
          key: 'query',
          value: query
        }]
      });
    });
  }
  return zipkins;
};


function TraceMiddleware(ns, config, logger, client) {
  const enabled = config.get('trace.enable');
  return name => (req, res, next) => {
    const spanId = randomString();
    const traceId = req.get('X-B3-TraceId') || spanId;
    const parentId = req.get('X-B3-SpanId') || '';
    const startedAt = process.hrtime();
    const timestamp = getMicroTimestamp();
    const serviceName = name || config.get('app.name');
    //目前默认全部采样
    let sampled = enabled ? 1 : 0;
    //只有service为第二级, 且通过参数关闭时才禁止采样
    if (sampled && parseInt(req.get('X-B3-Sampled'), 10) < 1 && parentId > 0) {
      sampled = 0;
    }
    const tracer = {
      serviceName,
      method: req.method,
      url: getHostFullUrl(req),
      port: getHostPort(req),
      spanId,
      traceId,
      parentId,
      sampled,
      timestamp,
      duration: null,
      statusCode: null,
      queries: [],
      debug: {}
    };

    res.set({
      'X-Service-Name': serviceName,
      'X-Requested-At': timestamp,
      'X-B3-SpanId': spanId,
      'X-B3-TraceId': traceId,
      'X-B3-ParentSpanId': parentId,
      'X-B3-Sampled': enabled ? 1 : 0
    });

    if (sampled < 1) {
      onHeaders(res, () => {
        const [seconds, nanoseconds] = process.hrtime(startedAt);
        const duration = ((seconds * 1e3) + (nanoseconds * 1e-6));
        res.set('X-Response-Milliseconds', parseInt(duration, 10));
      });
      next();
      return;
    }

    onHeaders(res, () => {
      const [seconds, nanoseconds] = process.hrtime(startedAt);
      const duration = ((seconds * 1e3) + (nanoseconds * 1e-6)) * 1000;
      tracer.duration = parseInt(duration, 10);
      tracer.statusCode = res.statusCode;
      res.set('X-Response-Milliseconds', tracer.duration / 1000);

      const useHeader = config.get('trace.header');
      if (!useHeader) {
        return;
      }
      const zipkins = tracerToZipkins(tracer);
      if (!zipkins) {
        logger.warn('Tracer not send by no data for request %s', spanId);
      } else {
        res.set(`X-Debug-${spanId}`, JSON.stringify(zipkins));
      }

      if (Object.keys(tracer.debug).length > 0) {
        Object.entries(tracer.debug).forEach(([key, value]) => {
          res.set(key.replace('x-debug', 'X-Debug'), value);
        });
      }
    });

    const recordZipkin = () => {
      const api = config.get('trace.api');
      if (!api) {
        return;
      }
      logger.debug('Tracer prepare to send for request %s', spanId);
      const zipkins = tracerToZipkins(ns.get('tracer'));
      if (!zipkins) {
        logger.warn('Tracer not send by no data for request %s', spanId);
        return;
      }
      client.request({
        url: api,
        method: 'POST',
        json: zipkins
      }).catch((e) => {
        logger.error('Error happened on sending tracing data', e);
      });
    };

    res.on('finish', recordZipkin);
    res.on('error', recordZipkin);

    ns.bindEmitter(req);
    ns.bindEmitter(res);
    ns.run(() => {
      // logger.debug('Tracer settled for request %s, tracer: %j', spanId, tracer);
      ns.set('tracer', tracer);
      next();
    });
  };
}

Dependencies(Namespace, Config, Logger, HttpClient)(TraceMiddleware); //eslint-disable-line new-cap

export default TraceMiddleware;

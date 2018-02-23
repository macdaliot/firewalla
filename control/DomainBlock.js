/*    Copyright 2016 Firewalla LLC 
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
'use strict';

const log = require("../net2/logger.js")(__filename);
const Promise = require('bluebird');

const redis = require('redis');
const rclient = redis.createClient();

Promise.promisifyAll(redis.RedisClient.prototype);
Promise.promisifyAll(redis.Multi.prototype);

const async = require('asyncawait/async')
const await = require('asyncawait/await')

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const Block = require('./Block.js');

const DNSTool = require('../net2/DNSTool.js')
const dnsTool = new DNSTool()

const dns = require('dns');
const resolve4Async = Promise.promisify(dns.resolve4)
const resolve6Async = Promise.promisify(dns.resolve6)

const sem = require('../sensor/SensorEventManager.js').getInstance();


class DomainBlock {

  constructor() {

  }

  // a mapping from domain to ip is tracked in redis, so that we can apply block at ip level, which is more secure
  blockDomain(domain, options) {
    options = options || {}
    return async(() => {
      await (dnsmasq.addPolicyFilterEntry(domain).catch((err) => undefined))

      sem.emitEvent({
        type: 'ReloadDNSRule',
        message: 'DNSMASQ filter rule is updated',
        toProcess: 'FireMain'
      })

      await (this.syncDomainIPMapping(domain, options))
      await (this.applyBlock(domain, options))
    })()
  }

  unblockDomain(domain, options) {
    return async(() => {
      await (this.unapplyBlock(domain, options))
      await (this.removeDomainIPMapping(domain, options))

      await (dnsmasq.removePolicyFilterEntry(domain).catch((err) => undefined))

      sem.emitEvent({
        type: 'ReloadDNSRule',
        message: 'DNSMASQ filter rule is updated',
        toProcess: 'FireMain'
      })
    })()
  }

  getDomainIPMappingKey(domain, options) {
    options = options || {}

    if(options.exactMatch) {
      return `ipmapping:site:${domain}`
    } else {
      return `ipmapping:domain:${domain}`
    }    
  }

  removeDomainIPMapping(domain, options) {
    const key = this.getDomainIPMappingKey(domain, options)
    return rclient.delAsync(key)
  }

  getMappedIPAddresses(domain, options) {
    const key = this.getDomainIPMappingKey(domain, options)
    return rclient.smembersAsync(key)
  }
  
  applyBlock(domain, options) {
    return async(() => {
      const addresses = await (this.getMappedIPAddresses(domain, options))
      if(addresses) {
        addresses.forEach((addr) => {
          await (Block.block(addr, "blocked_domain_set").catch((err) => undefined))
        })
      }
    })()
  }

  unapplyBlock(domain, options) {
    return async(() => {
      const addresses = await (this.getMappedIPAddresses(domain, options))
      if(addresses) {
        addresses.forEach((addr) => {
          await (Block.unblock(addr, "blocked_domain_set").catch((err) => undefined))
        })
      }
    })()
  }

  syncDomainIPMapping(domain, options) {
    options = options || {}

    const key = this.getDomainIPMappingKey(domain, options)
    
    return async(() => {
      const v4Addresses = await (resolve4Async(domain).catch((err) => []))
      await (dnsTool.addReverseDns(domain, v4Addresses))

      const v6Addresses = await (resolve6Async(domain).catch((err) => []))
      await (dnsTool.addReverseDns(domain, v6Addresses))

      let list = []

      // load other addresses from rdns, critical to apply instant blocking
      const addresses = await (dnsTool.getAddressesByDNS(domain).catch((err) => []))
      list.push.apply(list, addresses)

      if(!options.exactMatch) {
        const patternAddresses = await (dnsTool.getAddressesByDNSPattern(domain).catch((err) => []))
        list.push.apply(list, patternAddresses)
      }

      return rclient.saddAsync(key, list)

    })()     
  }

  getAllIPMappings() {
    return async(() => {
      let list = await (rclient.keysAsync("ipmapping:site:*"))
      let list2 = await (rclient.keysAsync("ipmapping:domain:*"))
      return list.concat(list2)
    })()
  }

  removeAllIPMappings() {
    return async(() => {
      const list = await (this.getAllIPMappings())
      return rclient.delAsync(list)
    })()
  }
}

module.exports = () => new DomainBlock()
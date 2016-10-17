import Ember from 'ember';
import Socket from 'ui/utils/socket';
import C from 'ui/utils/constants';

let DEADTOME = ['removed','purging','purged'];

const ORCHESTRATION_STACKS = [
  'infra*k8s',
  'infra*swarm',
  'infra*mesos'
];

export default Ember.Mixin.create({
  k8s             : Ember.inject.service(),
  projects        : Ember.inject.service(),
  'tab-session'   : Ember.inject.service(),

  subscribeSocket : null,
  reconnect: true,
  connected: false,
  k8sUidBlacklist : null,

  init() {
    this._super();
    this.set('k8sUidBlacklist', []);

    var store = this.get('store');

    var socket = Socket.create();

    socket.on('message', (event) => {
      Ember.run.schedule('actions', this, function() {
        // Fail-safe: make sure the message is for this project
        var currentProject = this.get(`tab-session.${C.TABSESSION.PROJECT}`);
        var metadata = socket.getMetadata();
        var socketProject = metadata.projectId;
        if ( currentProject !== socketProject ) {
          console.error(`Subscribe ignoring message, current=${currentProject} socket=${socketProject} ` + this.forStr());
          this.connectSubscribe();
          return;
        }

        var d = JSON.parse(event.data);
        let resource;
        if ( d.data && d.data.resource ) {
          resource = store._typeify(d.data.resource);
          d.data.resource = resource;
        }

        //this._trySend('subscribeMessage',d);

        if ( d.name === 'resource.change' )
        {
          let key = d.resourceType+'Changed';
          if ( this[key] ) {
            this[key](d);
          }

          if ( resource && DEADTOME.includes(resource.state) ) {
            store._remove(resource.type, resource);
          }
        }
        else if ( d.name === 'service.kubernetes.change' )
        {
          var changeType = (Ember.get(d, 'data.type')||'').toLowerCase();
          var obj = Ember.get(d, 'data.object');
          if ( changeType && obj )
          {
            this.k8sResourceChanged(changeType, obj);
          }
        }
        else if ( d.name === 'ping' )
        {
          this.subscribePing(d);
        }
      });
    });

    socket.on('connected', (tries, after) => {
      this.subscribeConnected(tries, after);
    });

    socket.on('disconnected', () => {
      this.subscribeDisconnected(this.get('tries'));
    });

    this.set('subscribeSocket', socket);
  },

  connectSubscribe() {
    var socket = this.get('subscribeSocket');
    var projectId = this.get(`tab-session.${C.TABSESSION.PROJECT}`);
    var url = ("ws://"+window.location.host + this.get('app.wsEndpoint')).replace(this.get('app.projectToken'), projectId);

    this.set('reconnect', true);

    socket.setProperties({
      url: url,
      autoReconnect: true,
    });
    socket.reconnect({projectId: projectId});
  },

  disconnectSubscribe(cb) {
    this.set('reconnect', false);
    var socket = this.get('subscribeSocket');
    if ( socket )
    {
      console.log('Subscribe disconnect ' + this.forStr());
      socket.disconnect(cb);
    }
    else if ( cb )
    {
      cb();
    }
  },


  forStr() {
    let out = '';
    let socket = this.get('subscribeSocket');
    var projectId = this.get(`tab-session.${C.TABSESSION.PROJECT}`);
    if ( socket )
    {
      out = '(projectId=' + projectId + ', sockId=' + socket.getId() + ')';
    }

    return out;
  },

  // WebSocket connected
  subscribeConnected: function(tries,msec) {
    this.set('connected', true);

    let msg = 'Subscribe connected ' + this.forStr();
    if (tries > 0)
    {
      msg += ' (after '+ tries + ' ' + (tries === 1 ? 'try' : 'tries');
      if (msec)
      {
        msg += ', ' + (msec/1000) + ' sec';
      }

      msg += ')';
    }

    console.log(msg);
  },

  // WebSocket disconnected (unexpectedly)
  subscribeDisconnected: function() {
    this.set('connected', false);

    console.log('Subscribe disconnected ' + this.forStr());
    if ( this.get('reconnect') ) {
      this.connectSubscribe();
    }
  },

  subscribePing: function() {
    console.log('Subscribe ping ' + this.forStr());
  },

  stackChanged: function(change) {
    let stack = change.data.resource;

    if ( ORCHESTRATION_STACKS.indexOf(stack.get('externalIdInfo.name')) >= 0 ) {
      Ember.run.once(this, function() {
        this.get('projects.current').reload().then(() => {
          this.get('projects').updateOrchestrationState();
        });
      });
    }
  },

  k8sResourceChanged: function(changeType, obj) {
    //console.log('k8s change', changeType, (obj && obj.metadata && obj.metadata.uid ? obj.metadata.uid : 'none'));
    if ( obj && obj.metadata && obj.metadata.uid && this.get('k8sUidBlacklist').indexOf(obj.metadata.uid) >= 0 )
    {
      //console.log('^-- Ignoring', changeType, 'for removed resource');
      return;
    }

    var resource = this.get('k8s')._typeify(obj);

    if ( changeType === 'deleted' )
    {
      this.get('k8sUidBlacklist').addObject(obj.metadata.uid);
      this.get('store')._remove(resource.get('type'), resource);
    }
  },
});

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import terraformService from '../services/terraformService';
import { Link } from 'react-router-dom';
import { toast } from 'react-hot-toast';
import axios from 'axios';
import API_BASE_URL, { TOKEN_KEY } from '../config';
import { SSHButton } from '../components/SSHButton';

// Interface untuk data VM
interface VMData {
  id: string;
  name: string;
  provider: string;
  region: string;
  instance_id?: string;
  status: string;
  public_ip: string | null;
  private_ip: string | null;
  created_at?: string;
  updated_at?: string;
  preset?: string;
  credential_id?: number;
}

// Interface untuk data credential
interface CredentialData {
  id: number;
  name: string;
  type: string;
}

// Interface untuk data instance GCP
interface GCPInstance {
  name: string;
  id: string;
  machineType: string;
  status: string;
  zone: string;
  networkInterfaces: any[];
}

const Dashboard: React.FC = () => {
  const { user } = useAuth();
  const [vms, setVms] = useState<VMData[]>([]);
  const [gcpInstances, setGcpInstances] = useState<Map<string, GCPInstance[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [filter, setFilter] = useState<string>('all'); // all, gcp, aws
  const [credentials, setCredentials] = useState<CredentialData[]>([]);
  const [selectedCredential, setSelectedCredential] = useState<number | null>(null);
  
  // Fungsi untuk mendapatkan daftar VM dari database
  const fetchVMs = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await terraformService.listVMs(1, 50); // Dapatkan 50 VM
      setVms(response.vms);
      setLastSyncTime(new Date());
    } catch (err: any) {
      setError('Gagal memuat daftar VM: ' + err.message);
      console.error('Error fetching VMs:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fungsi untuk mendapatkan daftar credential
  const fetchCredentials = useCallback(async () => {
    try {
      const response = await terraformService.getCredentials();
      setCredentials(response.credentials);
      
      // Set credential GCP pertama sebagai default (jika ada)
      const gcpCredential = response.credentials.find(cred => cred.type.toLowerCase() === 'gcp');
      if (gcpCredential) {
        setSelectedCredential(gcpCredential.id);
      }
    } catch (err: any) {
      console.error('Error fetching credentials:', err);
      toast.error('Gagal memuat daftar kredensial');
    }
  }, []);

  // Fungsi untuk mendapatkan VM langsung dari cloud provider menggunakan backend sebagai proxy
  const syncWithProvider = useCallback(async (credentialId: number) => {
    try {
      setIsRefreshing(true);
      toast.loading('Menyinkronkan data VM...', { id: 'sync-vms' });
      
      // Gunakan endpoint yang benar untuk sinkronisasi dengan credential_id sebagai query parameter
      const response = await axios.post(
        `${API_BASE_URL}/api/v1/vms/vms/sync?credential_id=${credentialId}`,
        {},  // Empty body since we're using query parameter
        {
          headers: {
            'Authorization': `Bearer ${localStorage.getItem(TOKEN_KEY)}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      if (response.status === 200) {
        // Setelah sinkronisasi berhasil, perbarui data VM dari database
        await fetchVMs();
        
        // Tampilkan pesan sukses dengan detail sinkronisasi
        const results = response.data.results;
        let message = 'Sinkronisasi berhasil: ';
        if (results.aws?.synced > 0) {
          message += `${results.aws.synced} VM AWS`;
          if (results.aws.deleted_count > 0) {
            message += ` (${results.aws.deleted_count} dihapus)`;
          }
          message += ', ';
        }
        if (results.gcp?.synced > 0) {
          message += `${results.gcp.synced} VM GCP, `;
        }
        message = message.replace(/, $/, ''); // Remove trailing comma
        
        toast.success(message, { id: 'sync-vms' });
        setLastSyncTime(new Date());
      } else {
        toast.error(`Gagal sinkronisasi VM: ${response.data.message || 'Terjadi kesalahan'}`, { id: 'sync-vms' });
      }
    } catch (err: any) {
      console.error('Error syncing VMs:', err);
      
      // Tampilkan pesan error yang lebih deskriptif
      const errorMessage = err.response?.data?.detail || err.response?.data?.message || err.message;
      toast.error(`Gagal sinkronisasi VM: ${errorMessage}`, { id: 'sync-vms' });
      
      // Fallback: tetap perbarui data dari database
      await fetchVMs();
    } finally {
      setIsRefreshing(false);
    }
  }, [fetchVMs]);

  // Refresh data VM
  const handleRefresh = async () => {
    try {
      setIsRefreshing(true);
      await fetchVMs();
      
      // Jika ada kredensial yang dipilih, lakukan sinkronisasi
      if (selectedCredential) {
        // Periksa apakah kredensial masih valid
        const credentialExists = credentials.some(cred => cred.id === selectedCredential);
        
        if (credentialExists) {
          await syncWithProvider(selectedCredential);
        } else {
          toast.error('Kredensial tidak valid atau tidak ditemukan');
          // Reset pilihan kredensial jika tidak valid
          setSelectedCredential(null);
        }
      }
      
      toast.success('Data VM berhasil diperbarui');
    } catch (err: any) {
      console.error('Error refreshing VMs:', err);
      toast.error('Gagal memperbarui data VM');
    } finally {
      setIsRefreshing(false);
    }
  };

  // Handle credential change
  const handleCredentialChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const credId = parseInt(e.target.value);
    setSelectedCredential(credId);
    
    // If a credential is selected (not empty), sync VMs
    if (credId) {
      const credential = credentials.find(c => c.id === credId);
      if (credential) {
        try {
          setIsRefreshing(true);
          // Use different endpoints based on credential type
          if (credential.type.toLowerCase() === 'aws') {
            await syncAWSVMs(credId);
          } else if (credential.type.toLowerCase() === 'gcp') {
            await syncGCPVMs(credId);
          }
        } catch (err) {
          console.error('Error syncing VMs:', err);
          toast.error('Gagal menyinkronkan VM');
        } finally {
          setIsRefreshing(false);
        }
      }
    }
  };

  // Sync AWS VMs
  const syncAWSVMs = async (credentialId: number) => {
    try {
      toast.loading('Menyinkronkan VM AWS...', { id: 'sync-aws' });
      
      const response = await axios.post(
        `${API_BASE_URL}/api/v1/vms/vms/sync-aws`,
        { credential_id: credentialId },
        {
          headers: {
            'Authorization': `Bearer ${localStorage.getItem(TOKEN_KEY)}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      if (response.status === 200) {
        await fetchVMs();
        toast.success(response.data.message, { id: 'sync-aws' });
        setLastSyncTime(new Date());
      } else {
        toast.error(`Gagal sinkronisasi VM AWS: ${response.data.message || 'Terjadi kesalahan'}`, { id: 'sync-aws' });
      }
    } catch (err: any) {
      const errorMessage = err.response?.data?.detail || err.response?.data?.message || err.message;
      toast.error(`Gagal sinkronisasi VM AWS: ${errorMessage}`, { id: 'sync-aws' });
      await fetchVMs();
    }
  };

  // Sync GCP VMs
  const syncGCPVMs = async (credentialId: number) => {
    try {
      toast.loading('Menyinkronkan VM GCP...', { id: 'sync-gcp' });
      
      const response = await axios.post(
        `${API_BASE_URL}/api/v1/vms/vms/sync-gcp`,
        { credential_id: credentialId },
        {
          headers: {
            'Authorization': `Bearer ${localStorage.getItem(TOKEN_KEY)}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      if (response.status === 200) {
        await fetchVMs();
        toast.success(response.data.message, { id: 'sync-gcp' });
        setLastSyncTime(new Date());
      } else {
        toast.error(`Gagal sinkronisasi VM GCP: ${response.data.message || 'Terjadi kesalahan'}`, { id: 'sync-gcp' });
      }
    } catch (err: any) {
      const errorMessage = err.response?.data?.detail || err.response?.data?.message || err.message;
      toast.error(`Gagal sinkronisasi VM GCP: ${errorMessage}`, { id: 'sync-gcp' });
      await fetchVMs();
    }
  };

  // Filter VMs based on selected credential and provider filter
  const filteredVMs = useMemo(() => {
    return vms.filter(vm => {
      // Filter by provider if not "all"
      if (filter !== 'all' && vm.provider.toLowerCase() !== filter) {
        return false;
      }
      
      // Filter by selected credential
      if (selectedCredential && vm.credential_id !== selectedCredential) {
        return false;
      }
      
      return true;
    });
  }, [vms, filter, selectedCredential]);

  // Fungsi untuk menangani aksi start VM
  const handleStartVM = async (vmId: string) => {
    try {
      toast.loading('Memulai VM...', { id: `start-${vmId}` });
      await terraformService.startVM(parseInt(vmId));
      toast.success('VM berhasil dimulai', { id: `start-${vmId}` });
      fetchVMs(); // Refresh data setelah start
    } catch (err: any) {
      toast.error(`Gagal memulai VM: ${err.message}`, { id: `start-${vmId}` });
    }
  };

  // Fungsi untuk menangani aksi stop VM
  const handleStopVM = async (vmId: string) => {
    try {
      toast.loading('Menghentikan VM...', { id: `stop-${vmId}` });
      await terraformService.stopVM(parseInt(vmId));
      toast.success('VM berhasil dihentikan', { id: `stop-${vmId}` });
      fetchVMs(); // Refresh data setelah stop
    } catch (err: any) {
      toast.error(`Gagal menghentikan VM: ${err.message}`, { id: `stop-${vmId}` });
    }
  };

  // Fungsi untuk menangani aksi delete VM
  const handleDeleteVM = async (vmId: string) => {
    if (window.confirm('Anda yakin ingin menghapus VM ini? Tindakan ini tidak dapat dibatalkan.')) {
      try {
        toast.loading('Menghapus VM...', { id: `delete-${vmId}` });
        await terraformService.deleteVM(parseInt(vmId));
        toast.success('VM berhasil dihapus', { id: `delete-${vmId}` });
        fetchVMs(); // Refresh data setelah delete
      } catch (err: any) {
        toast.error(`Gagal menghapus VM: ${err.message}`, { id: `delete-${vmId}` });
      }
    }
  };

  // Mendapatkan warna badge berdasarkan status VM
  const getStatusColor = (status: string) => {
    status = status.toLowerCase();
    if (status.includes('running')) return 'bg-green-100 text-green-800';
    if (status.includes('creating') || status.includes('provisioning')) return 'bg-blue-100 text-blue-800';
    if (status.includes('stopped') || status.includes('terminated')) return 'bg-gray-100 text-gray-800';
    if (status.includes('failed')) return 'bg-red-100 text-red-800';
    return 'bg-yellow-100 text-yellow-800';
  };

  // Mendapatkan icon provider
  const getProviderIcon = (provider: string) => {
    if (provider.toLowerCase() === 'gcp') {
      return (
        <svg className="w-6 h-6" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 7l-10 10h20L12 7z M12 0L1 11h22L12 0z M1 19h22v4H1v-4z"/>
        </svg>
      );
    } else if (provider.toLowerCase() === 'aws') {
      return (
        <svg className="w-6 h-6" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19.3 10.2c.3 0 .5.2.6.5v1.8c0 .3-.3.5-.6.5s-.5-.2-.5-.5v-1.8c0-.3.2-.5.5-.5zm-1.4 0l.7.4c.2.1.3.3.3.5v.5c0 .3-.2.5-.4.6-.1 0-.1.1-.1.1.1 0 .3.2.3.3 0 .1.1.3.1.5v.5c0 .1 0 .3.1.4.1.1.1.1.1.2v.1h-.6v-.1s0-.1-.1-.1v-.6c0-.3 0-.5-.2-.6-.1-.1-.3-.1-.4-.1h-.3v1.4h-.6V10.2h1.1zm-.4 1.6h.4c.2 0 .3 0 .4-.1.1-.1.1-.2.1-.3s-.1-.2-.1-.3c-.1-.1-.2-.1-.4-.1h-.4v.8zM13.7 12v1c0 .3.1.5.3.6.1.1.3.2.5.2s.4-.1.5-.2c.2-.1.2-.3.2-.6v-1c0-.3-.1-.5-.2-.6-.1-.1-.3-.2-.5-.2s-.4.1-.5.2c-.2.1-.3.3-.3.6zm1 0v1c0 .1 0 .2-.1.3 0 0-.1.1-.3.1s-.2 0-.3-.1c-.1-.1-.2-.3-.2-.5v-1c0-.2 0-.4.1-.5.1 0 .2-.1.3-.1s.2 0 .3.1c.1.1.1.2.1.3zM11.3 12v1c0 .3.1.5.3.6.1.1.3.2.5.2s.4-.1.5-.2c.2-.1.2-.3.2-.6v-1c0-.3-.1-.5-.2-.6-.1-.1-.3-.2-.5-.2s-.4.1-.5.2c-.2.1-.3.3-.3.6zm1 0v1c0 .1 0 .2-.1.3 0 0-.1.1-.3.1s-.2 0-.3-.1c-.1-.1-.1-.2-.1-.3v-1c0-.1 0-.2.1-.3.1 0 .2-.1.3-.1s.2 0 .3.1c.1.1.1.2.1.3zM10.1 10.2c.4 0 .7.1.9.4.2.3.3.6.3 1.1v.4c0 .5-.1.8-.3 1.1-.2.3-.5.4-.9.4h-.5c-.4 0-.7-.1-.9-.4-.2-.3-.3-.6-.3-1.1v-.4c0-.5.1-.8.3-1.1.2-.3.5-.4.9-.4h.5zm-.5.5c-.2 0-.4.1-.5.2-.1.2-.2.4-.2.7v.5c0 .3.1.6.2.7.1.2.3.2.5.2h.5c.2 0 .4-.1.5-.2.1-.2.2-.4.2-.7v-.4c0-.3-.1-.6-.2-.7-.1-.2-.3-.2-.5-.2h-.5zM7.9 13.8h-.6v-2.6h-1v-.5h2.5v.5h-1v2.6zm9.2-3.2v1.8c0 .4-.1.7-.3.9-.2.2-.5.3-.9.3s-.7-.1-.9-.3c-.2-.2-.3-.5-.3-.9v-1.8c0-.4.1-.7.3-.9.2-.2.5-.3.9-.3s.7.1.9.3c.2.3.3.6.3.9zm-2 0v1.8c0 .2.1.4.2.5.1.1.3.2.5.2s.4-.1.5-.2c.1-.1.2-.3.2-.5v-1.8c0-.2-.1-.4-.2-.5-.1-.1-.3-.2-.5-.2s-.4.1-.5.2c-.1.1-.2.3-.2.5z" />
        </svg>
      );
    }
    return null;
  };

  useEffect(() => {
    fetchVMs();
    fetchCredentials();
  }, [fetchVMs, fetchCredentials]);

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold mb-6">Dashboard</h1>
      
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h5 className="text-xl font-semibold mb-2">Selamat datang, {user?.username}!</h5>
        <p className="text-gray-600">
          Ini adalah dashboard untuk mengelola virtual machine Anda di berbagai cloud provider.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold mb-2">Virtual Machines</h3>
          <p className="text-gray-600 mb-4">Kelola virtual machine di berbagai provider cloud</p>
          <Link to="/create-vm" className="bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded inline-block">
            Kelola VM
          </Link>
        </div>
        
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold mb-2">Credentials</h3>
          <p className="text-gray-600 mb-4">Kelola credential untuk akses ke cloud provider</p>
          <Link to="/credentials" className="bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded inline-block">
            Kelola Credentials
          </Link>
        </div>
        
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold mb-2">Deployment History</h3>
          <p className="text-gray-600 mb-4">Lihat riwayat deployment dan aktivitas</p>
          <Link to="/history" className="bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded inline-block">
            Lihat History
          </Link>
        </div>
      </div>

      {/* Bagian VM List */}
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold">Virtual Machines</h2>
          <div className="flex space-x-4">
            <div className="flex items-center space-x-2">
              <label htmlFor="credential" className="text-sm text-gray-600">Credential:</label>
              <select 
                id="credential"
                className="border border-gray-300 rounded px-3 py-1 text-sm"
                value={selectedCredential || ''}
                onChange={handleCredentialChange}
              >
                <option value="">Pilih Kredensial</option>
                {credentials
                  .map(cred => (
                    <option key={cred.id} value={cred.id}>
                      {cred.name} ({cred.type})
                    </option>
                  ))
                }
              </select>
            </div>
            <div className="flex items-center space-x-2">
              <label htmlFor="filter" className="text-sm text-gray-600">Filter:</label>
              <select 
                id="filter"
                className="border border-gray-300 rounded px-3 py-1 text-sm"
                value={filter}
                onChange={e => setFilter(e.target.value)}
              >
                <option value="all">Semua Provider</option>
                <option value="gcp">Google Cloud</option>
                <option value="aws">AWS</option>
              </select>
            </div>
            <button 
              onClick={handleRefresh} 
              className="flex items-center justify-center bg-gray-100 hover:bg-gray-200 rounded-md px-3 py-1"
              disabled={isRefreshing}
            >
              <svg 
                className={`w-4 h-4 mr-1 ${isRefreshing ? 'animate-spin' : ''}`} 
                fill="none" 
                stroke="currentColor" 
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Refresh
            </button>
            <Link 
              to="/quick-deploy" 
              className="flex items-center justify-center bg-blue-500 hover:bg-blue-600 text-white rounded-md px-4 py-1"
            >
              <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
              New VM
            </Link>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex justify-center items-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
            <span className="ml-2">Loading VMs...</span>
          </div>
        ) : filteredVMs.length === 0 ? (
          <div className="bg-gray-50 rounded-lg p-8 text-center">
            <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            <h3 className="mt-2 text-lg font-medium text-gray-900">Tidak ada VM</h3>
            <p className="mt-1 text-gray-500">Anda belum memiliki virtual machine. Klik tombol "New VM" untuk membuat VM baru.</p>
            <div className="mt-6">
              <Link to="/quick-deploy" className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700">
                <svg className="-ml-1 mr-2 h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                </svg>
                Buat VM Baru
              </Link>
            </div>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Nama VM
                    </th>
                    <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Provider
                    </th>
                    <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Lokasi
                    </th>
                    <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                    <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      IP
                    </th>
                    <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Aksi
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {filteredVMs.map((vm) => (
                    <tr key={vm.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center">
                          <div className="flex-shrink-0 h-10 w-10 flex items-center justify-center">
                            <div className="rounded-full bg-gray-100 p-2">
                              {getProviderIcon(vm.provider)}
                            </div>
                          </div>
                          <div className="ml-4">
                            <div className="text-sm font-medium text-gray-900">{vm.name}</div>
                            <div className="text-xs text-gray-500">ID: {vm.id}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900">{vm.provider.toUpperCase()}</div>
                        {vm.preset && (
                          <div className="text-xs text-gray-500">{vm.preset.replace('_', ' ')}</div>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900">{vm.region}</div>
                        <div className="text-xs text-gray-500">{vm.instance_id ? vm.instance_id.substring(0, 8) + '...' : '—'}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`px-2 py-1 text-xs font-medium rounded-full ${getStatusColor(vm.status)}`}>
                          {vm.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        <div className="text-sm">{vm.public_ip || '—'}</div>
                        <div className="text-xs text-gray-500">{vm.private_ip || '—'}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <div className="flex space-x-2">
                          {vm.status.toLowerCase().includes('running') ? (
                            <button 
                              onClick={() => handleStopVM(vm.id)}
                              className="px-3 py-1 bg-yellow-50 text-yellow-700 border border-yellow-200 rounded text-xs hover:bg-yellow-100"
                            >
                              Stop
                            </button>
                          ) : vm.status.toLowerCase().includes('stopped') ? (
                            <button 
                              onClick={() => handleStartVM(vm.id)}
                              className="px-3 py-1 bg-green-50 text-green-700 border border-green-200 rounded text-xs hover:bg-green-100"
                            >
                              Start
                            </button>
                          ) : null}
                          
                          <button 
                            onClick={() => handleDeleteVM(vm.id)}
                            className="px-3 py-1 bg-red-50 text-red-700 border border-red-200 rounded text-xs hover:bg-red-100"
                          >
                            Delete
                          </button>
                          
                          <Link 
                            to={`/vm/${vm.id}`}
                            className="px-3 py-1 bg-blue-50 text-blue-700 border border-blue-200 rounded text-xs hover:bg-blue-100"
                          >
                            Detail
                          </Link>
                          <SSHButton
                            vmId={parseInt(vm.id)}
                            vmName={vm.name}
                            isRunning={vm.status.toLowerCase().includes('running')}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            
            <div className="mt-4 text-sm text-gray-500 flex items-center">
              <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {lastSyncTime && (
                <span>Terakhir diperbarui: {lastSyncTime.toLocaleTimeString()}</span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default Dashboard;
